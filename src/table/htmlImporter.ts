// Convert an HTML clipboard payload (Excel, Word, web tables) into a
// TableModel.
//
// Excel-on-Windows places its rich payload behind an HTML "Fragment" envelope
// with `<!--StartFragment-->` / `<!--EndFragment-->` markers. We strip the
// envelope, parse with the platform DOMParser, then walk the first `<table>`.
// Rowspan / colspan attributes are honored and translated to merge anchors
// + placeholders so downstream serialization can emit either MultiMarkdown
// `^^` / `||` or HTML, depending on the user's setting.

import {
  Cell,
  TableModel,
  makeAnchor,
  makeMergeLeft,
  makeMergeUp,
  recomputeSpans,
} from "./model";

/** Try to extract a `<table>` from an HTML clipboard payload. */
export function importHtmlTable(html: string): TableModel | null {
  const trimmed = stripFragmentEnvelope(html).trim();
  if (!trimmed) return null;
  const doc = new DOMParser().parseFromString(trimmed, "text/html");
  const table = doc.querySelector("table");
  if (!table) return null;
  return tableElementToModel(table);
}

function stripFragmentEnvelope(html: string): string {
  const start = html.indexOf("<!--StartFragment-->");
  const end = html.indexOf("<!--EndFragment-->");
  if (start >= 0 && end > start) {
    return html.slice(start + "<!--StartFragment-->".length, end);
  }
  return html;
}

/**
 * Walk a real `<table>` and produce a TableModel. We reserve a row × column
 * grid up front (filled with blank anchors) and then write each `<td>` into
 * its computed slot, padding placeholder cells for rowspan/colspan.
 */
function tableElementToModel(table: HTMLTableElement): TableModel | null {
  const trs = Array.from(table.querySelectorAll<HTMLTableRowElement>("tr"));
  if (!trs.length) return null;
  // First pass: figure out row count and the maximum effective column count
  // by simulating rowspan placement.
  const rowOccupancy: Array<Array<boolean>> = trs.map(() => []);
  let maxCols = 0;
  for (let r = 0; r < trs.length; r++) {
    const cells = Array.from(trs[r].children).filter(
      (el): el is HTMLTableCellElement => el.tagName === "TD" || el.tagName === "TH",
    );
    let c = 0;
    for (const cell of cells) {
      while (rowOccupancy[r][c]) c++;
      const rs = clampSpan(cell.getAttribute("rowspan"));
      const cs = clampSpan(cell.getAttribute("colspan"));
      for (let dr = 0; dr < rs; dr++) {
        const target = rowOccupancy[r + dr] ?? (rowOccupancy[r + dr] = []);
        for (let dc = 0; dc < cs; dc++) {
          target[c + dc] = true;
        }
      }
      c += cs;
      if (c > maxCols) maxCols = c;
    }
  }
  // Some tables may have rowspans extending past the last `<tr>`. Treat the
  // overflow as additional rows.
  const rows = rowOccupancy.length;
  const cols = Math.max(1, maxCols);

  const grid: Cell[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: Cell[] = [];
    for (let c = 0; c < cols; c++) row.push(makeAnchor(""));
    grid.push(row);
  }

  // Second pass: write actual content into the right anchor slot.
  const written: boolean[][] = Array.from({ length: rows }, () => []);
  let headerRows = 0;
  for (let r = 0; r < trs.length; r++) {
    const cells = Array.from(trs[r].children).filter(
      (el): el is HTMLTableCellElement => el.tagName === "TD" || el.tagName === "TH",
    );
    if (cells.length && cells.every((cell) => cell.tagName === "TH")) {
      headerRows = r + 1;
    }
    let c = 0;
    for (const cell of cells) {
      while (written[r][c]) c++;
      const rs = clampSpan(cell.getAttribute("rowspan"));
      const cs = clampSpan(cell.getAttribute("colspan"));
      const text = cellText(cell);
      grid[r][c] = makeAnchor(text);
      // Mark the anchor's footprint so `c` advances correctly in this row.
      for (let dr = 0; dr < rs; dr++) {
        for (let dc = 0; dc < cs; dc++) {
          if (r + dr >= rows || c + dc >= cols) continue;
          written[r + dr] = written[r + dr] ?? [];
          written[r + dr][c + dc] = true;
          if (dr === 0 && dc === 0) continue;
          if (dc === 0) {
            grid[r + dr][c + dc] = makeMergeUp(dr, 0);
          } else if (dr === 0) {
            grid[r][c + dc] = makeMergeLeft(dc, 0);
          } else {
            // Block-merge corner: chain through merge-up (rows) so the
            // anchor offset chain resolves back to (r, c).
            grid[r + dr][c + dc] = makeMergeUp(dr, 0);
          }
        }
      }
      c += cs;
    }
  }

  // GFM requires at least one header row. If the source had none, force the
  // first row to be the header so the markdown parses cleanly when re-read.
  if (headerRows === 0) headerRows = 1;

  const model: TableModel = {
    rows: grid,
    aligns: new Array(cols).fill("none"),
    headerRows,
    cols,
    tbodyBreaks: [],
  };
  recomputeSpans(model);
  return model;
}

function clampSpan(attr: string | null): number {
  if (!attr) return 1;
  const n = parseInt(attr, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, 200); // sanity cap
}

/**
 * Pull a usable plaintext representation out of a cell. Excel uses
 * `<br>` / `<p>` for newlines; we collapse them to a literal `<br>` token in
 * the markdown source.
 *
 * Why `<br>` and not MultiMarkdown's `\` continuation? Because Obsidian's
 * Live Preview widget doesn't understand `\` continuation: every physical
 * line becomes its own `<tr>`, which in turn breaks `applyMergesInPlace`'s
 * 1-to-1 mapping between model rows and DOM rows — `rowspan` ends up on the
 * wrong cell and the user sees the merge "disappear". `<br>` keeps every
 * logical row on a single physical line, so merged cells continue to render
 * correctly while still producing a visible line break thanks to the inline
 * markdown renderer (Reading view) and our `<br>`-text → `<br>`-element pass
 * in `livePreview.ts`.
 */
function cellText(cell: HTMLElement): string {
  // Replace <br> with a newline marker, then read textContent.
  const clone = cell.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
  // Block-level elements should also produce line breaks.
  clone.querySelectorAll("p, div, li").forEach((el) => {
    el.append("\n");
  });
  const text = (clone.textContent ?? "").replace(/\u00a0/g, " ");
  // Collapse runs of whitespace per line, then trim.
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line, idx, arr) => !(line === "" && (idx === 0 || idx === arr.length - 1)))
    .join("<br>")
    .replace(/\|/g, "\\|"); // escape pipes so the markdown round-trips.
}
