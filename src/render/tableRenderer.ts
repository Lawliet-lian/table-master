// Shared logic for taking a TableModel and applying it to an existing
// (Obsidian-rendered) HTML table. Used by both the reading-view
// post-processor and the live-preview view plugin.

import type { Component, MarkdownRenderer as MdRenderer } from "obsidian";
import { MarkdownRenderer } from "obsidian";
import { TableModel } from "../table/model";

export interface ApplyOptions {
  sourcePath: string;
  component: Component;
  /** Re-render markdown inside each anchor cell (lists, code blocks, etc). */
  renderInline?: boolean;
}

/**
 * Replace `table`'s row/cell structure with what `model` describes. The
 * existing table is wiped and rebuilt to match the model exactly so that
 * rowspan / colspan / multiple tbody / caption / headerless tables all line
 * up with the underlying markdown.
 */
export async function applyModelToTable(
  table: HTMLTableElement,
  model: TableModel,
  opts: ApplyOptions,
): Promise<void> {
  if (table.dataset.tmRendered === modelSignature(model)) return;

  // Snapshot styles so we can re-apply them once we replace the body.
  const className = table.className;
  table.innerHTML = "";
  table.className = className;
  table.classList.add("tm-rendered");

  if (model.caption) {
    const cap = document.createElement("caption");
    cap.textContent = model.caption.text;
    table.appendChild(cap);
  }

  if (model.headerRows > 0) {
    const thead = document.createElement("thead");
    for (let r = 0; r < model.headerRows; r++) {
      thead.appendChild(rowToTr(model, r, "th", opts));
    }
    table.appendChild(thead);
  }

  if (model.rows.length > model.headerRows) {
    const breaks = new Set(model.tbodyBreaks ?? []);
    let tbody: HTMLTableSectionElement | null = null;
    for (let r = model.headerRows; r < model.rows.length; r++) {
      if (!tbody || breaks.has(r)) {
        tbody = document.createElement("tbody");
        table.appendChild(tbody);
      }
      tbody.appendChild(rowToTr(model, r, "td", opts));
    }
  }

  // Inline markdown rendering happens after structure is in place so async
  // renderers don't fight with us removing/reordering nodes.
  if (opts.renderInline) await renderCellsInline(table, model, opts);

  table.dataset.tmRendered = modelSignature(model);
}

function rowToTr(
  model: TableModel,
  r: number,
  tag: "th" | "td",
  opts: ApplyOptions,
): HTMLTableRowElement {
  const tr = document.createElement("tr");
  for (let c = 0; c < model.cols; c++) {
    const cell = model.rows[r][c];
    if (!cell.isAnchor) continue;
    const td = document.createElement(tag);
    if (cell.rowspan > 1) td.setAttribute("rowspan", String(cell.rowspan));
    if (cell.colspan > 1) td.setAttribute("colspan", String(cell.colspan));
    const align = model.aligns[c];
    if (align && align !== "none") td.style.textAlign = align;
    td.dataset.tmRow = String(r);
    td.dataset.tmCol = String(c);
    if (!opts.renderInline) {
      // Best-effort plain rendering: replace `\n` with <br> so multi-line
      // continuation cells stay legible until the inline renderer (below)
      // takes over.
      const pieces = cell.raw.split("\n");
      pieces.forEach((piece, idx) => {
        if (idx > 0) td.appendChild(document.createElement("br"));
        td.appendChild(document.createTextNode(piece));
      });
    }
    tr.appendChild(td);
  }
  return tr;
}

async function renderCellsInline(
  table: HTMLTableElement,
  model: TableModel,
  opts: ApplyOptions,
): Promise<void> {
  const cells = table.querySelectorAll<HTMLTableCellElement>("td[data-tm-row], th[data-tm-row]");
  const renderer: typeof MdRenderer | null = (MarkdownRenderer ?? null) as unknown as typeof MdRenderer;
  if (!renderer) return;
  for (const td of Array.from(cells)) {
    const r = parseInt(td.dataset.tmRow ?? "-1", 10);
    const c = parseInt(td.dataset.tmCol ?? "-1", 10);
    if (r < 0 || c < 0) continue;
    const cell = model.rows[r]?.[c];
    if (!cell) continue;
    td.empty?.();
    td.innerHTML = "";
    const text = cell.raw.replace(/\\\n/g, "\n");
    try {
      // Newer Obsidian versions expose `render`; older ones `renderMarkdown`.
      // Both have signature (markdown, el, sourcePath, component).
      type MarkdownRenderFn = (
        markdown: string,
        el: HTMLElement,
        sourcePath: string,
        component: Component,
      ) => Promise<unknown>;
      const fn = (renderer as unknown as { render?: MarkdownRenderFn }).render
        ?? (renderer as unknown as { renderMarkdown?: MarkdownRenderFn }).renderMarkdown;
      if (typeof fn === "function") {
        await fn.call(renderer, text, td, opts.sourcePath, opts.component);
        unwrapTrailingParagraph(td);
      } else {
        td.textContent = text;
      }
    } catch {
      td.textContent = text;
    }
  }
}

function unwrapTrailingParagraph(td: HTMLElement): void {
  // Markdown often wraps single-line content in a <p>; remove the wrapping <p>
  // when it's the sole child to keep table layout compact.
  if (td.children.length === 1 && td.firstElementChild?.tagName === "P") {
    const p = td.firstElementChild as HTMLElement;
    while (p.firstChild) td.appendChild(p.firstChild);
    p.remove();
  }
}

/** Lightweight hash so repeated post-processor invocations do nothing. */
function modelSignature(model: TableModel): string {
  const parts: string[] = [
    String(model.headerRows),
    String(model.cols),
    JSON.stringify(model.tbodyBreaks ?? []),
    model.caption ? `${model.caption.text}|${model.caption.label ?? ""}` : "",
  ];
  for (const row of model.rows) {
    const cells = row.map((cell) =>
      cell.isAnchor
        ? `A:${cell.rowspan}:${cell.colspan}:${cell.raw}`
        : `P:${cell.anchorRowOffset}:${cell.anchorColOffset}`,
    );
    parts.push(cells.join("|"));
  }
  return parts.join("\n");
}
