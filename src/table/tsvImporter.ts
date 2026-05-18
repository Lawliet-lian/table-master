// Convert a TSV/plain-text clipboard payload (Excel range, Google Sheets) into
// a TableModel. Excel uses tabs to separate cells and CRLF/LF for rows.
//
// Cells may contain embedded newlines wrapped in double quotes (`"line 1\nline
// 2"`); we honour that quoting per RFC 4180 with tab as the delimiter.

import { Align, Cell, TableModel, makeAnchor } from "./model";

/** Try to parse a TSV string into a TableModel. Returns null when it doesn't
 *  look tabular (no tabs anywhere, no useful row separation). */
export function importTsvTable(tsv: string): TableModel | null {
  const text = tsv.replace(/\r\n?/g, "\n");
  if (!text.trim()) return null;
  const rows = parseRows(text);
  if (rows.length < 1) return null;
  // Require at least one tab somewhere — otherwise this is just a paragraph.
  const hasTab = rows.some((row) => row.length > 1);
  if (!hasTab) return null;
  const cols = Math.max(1, ...rows.map((r) => r.length));
  const grid: Cell[][] = rows.map((row) => {
    const padded = row.slice();
    while (padded.length < cols) padded.push("");
    return padded.map((value) => makeAnchor(escapePipes(value)));
  });
  if (grid.length < 2) {
    // Force a body row so the GFM serializer always emits a separator + body.
    grid.push(new Array(cols).fill(0).map(() => makeAnchor("")));
  }
  return {
    rows: grid,
    aligns: Array.from({ length: cols }, (): Align => "none"),
    headerRows: 1,
    cols,
    tbodyBreaks: [],
  };
}

/** Split a TSV document into rows of cells, honoring quoted multi-line cells. */
function parseRows(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let buf = "";
  let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuote) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          buf += '"';
          i++;
        } else {
          inQuote = false;
        }
      } else {
        buf += ch;
      }
      continue;
    }
    if (ch === '"' && buf === "") {
      inQuote = true;
      continue;
    }
    if (ch === "\t") {
      row.push(buf);
      buf = "";
      continue;
    }
    if (ch === "\n") {
      row.push(buf);
      out.push(row);
      row = [];
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.length > 0 || row.length > 0) {
    row.push(buf);
    out.push(row);
  }
  // Strip a trailing all-empty row (Excel pastes often end with a blank line).
  while (out.length && out[out.length - 1].every((cell) => cell === "")) {
    out.pop();
  }
  return out;
}

function escapePipes(value: string): string {
  // Cells coming from TSV may contain pipes that would otherwise terminate a
  // markdown column; escape them. Newlines become `<br>` so each logical row
  // stays on a single physical line — see the long comment in
  // htmlImporter.ts#cellText for why we don't use `\` continuation.
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, "<br>");
}
