// Live Preview merge renderer.
//
// Obsidian renders tables in Live Preview through a CodeMirror widget. We
// previously re-rendered the entire `<table>` (innerHTML wipe + async
// MarkdownRenderer.render), which confused CodeMirror: as soon as the user
// typed inside the table, CM6 decided the widget had been mutated under it
// and fell back to rendering the raw source as cm-line text — the table
// visibly "lost" its formatting.
//
// The lightweight strategy below avoids that by limiting our DOM mutations
// to attribute toggles and a single `display: none` on placeholder cells.
// Cell text is left untouched, no async work is scheduled, so the widget
// stays in a state CM6 considers consistent.

import { EditorView, ViewPlugin, ViewUpdate, PluginValue } from "@codemirror/view";
import { isSeparatorLine, parseTable } from "../table/parser";
import { isCaptionLine, isColWidthsLine, isStructuralTableLine } from "../table/structural";
import { cloneModel, type TableModel } from "../table/model";
import { serialize, type OutputFormat } from "../table/serializer";

// Live Preview 单独使用更高的拖拽下限。阅读模式和网格编辑器继续沿用
// TableModel 的全局 MIN_COL_WIDTH，这样可以保持当前阅读模式“看起来挺好”的
// 现状，同时把 LP 交互最小宽度固定到用户要求的 33。
const LP_MIN_COL_WIDTH = 33;

interface LivePreviewHost {
  getOutputFormat(): OutputFormat;
}

interface TableBinding {
  source: TableSource;
  model: TableModel;
}

interface DragState {
  table: HTMLTableElement;
  source: TableSource;
  model: TableModel;
  widths: number[];
  startWidths: number[];
  minWidths: number[];
  col: number;
  startX: number;
}

export function buildLivePreviewExt(host: LivePreviewHost) {
  return ViewPlugin.fromClass(
    class implements PluginValue {
      view: EditorView;
      timer: number | null = null;
      bindings = new WeakMap<HTMLTableElement, TableBinding>();
      hoverTable: HTMLTableElement | null = null;
      overlayEl: HTMLElement;
      guideEl: HTMLElement;
      drag: DragState | null = null;
      mouseMoveListener: (e: MouseEvent) => void;
      scrollListener: () => void;
      pointerMoveListener: (e: PointerEvent) => void;
      pointerUpListener: (e: PointerEvent) => void;

      constructor(view: EditorView) {
        this.view = view;
        const doc = view.dom.ownerDocument;
        this.overlayEl = doc.createElement("div");
        this.overlayEl.className = "tm-lp-col-overlay";
        this.guideEl = doc.createElement("div");
        this.guideEl.className = "tm-lp-col-guide is-hidden";
        this.overlayEl.appendChild(this.guideEl);
        doc.body.appendChild(this.overlayEl);
        this.mouseMoveListener = (e) => this.handleMouseMove(e);
        this.scrollListener = () => this.refreshOverlay();
        this.pointerMoveListener = (e) => this.handlePointerMove(e);
        this.pointerUpListener = (e) => this.handlePointerUp(e);
        doc.addEventListener("mousemove", this.mouseMoveListener, { passive: true });
        view.scrollDOM.addEventListener("scroll", this.scrollListener, { passive: true });
        const win = doc.defaultView ?? activeWindow;
        win.addEventListener("scroll", this.scrollListener, { passive: true, capture: true });
        this.schedule();
      }

      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged || u.geometryChanged) this.schedule();
        if (u.geometryChanged || u.viewportChanged) this.refreshOverlay();
        if (u.focusChanged && !u.view.hasFocus && !this.drag) this.hideOverlay();
      }

      destroy() {
        if (this.timer != null) {
          // Use the editor's own window so the timer is cleared in popout
          // windows too. Bare `window` would only resolve to the main window
          // and trip obsidianmd's `prefer-active-doc` lint rule.
          const win = this.view.dom.ownerDocument.defaultView ?? activeWindow;
          win.clearTimeout(this.timer);
          this.timer = null;
        }
        const doc = this.view.dom.ownerDocument;
        const win = doc.defaultView ?? activeWindow;
        doc.removeEventListener("mousemove", this.mouseMoveListener);
        this.view.scrollDOM.removeEventListener("scroll", this.scrollListener);
        win.removeEventListener("scroll", this.scrollListener, true);
        doc.removeEventListener("pointermove", this.pointerMoveListener);
        doc.removeEventListener("pointerup", this.pointerUpListener);
        this.overlayEl.remove();
      }

      private schedule() {
        if (this.timer != null) return;
        const win = this.view.dom.ownerDocument.defaultView ?? activeWindow;
        this.timer = win.setTimeout(() => {
          this.timer = null;
          this.run();
        }, 50);
      }

      private run() {
        const tables = Array.from(this.view.dom.querySelectorAll<HTMLTableElement>("table"));
        if (!tables.length) {
          this.hideOverlay();
          return;
        }
        const docLines = this.view.state.doc.toString().split(/\r?\n/);
        const sources = collectTableSources(docLines);
        if (!sources.length) {
          this.hideOverlay();
          return;
        }
        // Match each rendered <table> to the source block that produced it by
        // mapping the table's DOM position back to a document line. Matching by
        // index would break as soon as CodeMirror unmounts off-screen widgets:
        // when only some tables are in the viewport, the surviving DOM tables
        // would otherwise be paired with the wrong source blocks (causing the
        // "merge style breaks when scrolled" symptom on long ^^ chains).
        for (const table of tables) {
          if (!table.isConnected) continue;
          const source = this.findSourceFor(table, sources);
          if (!source) continue;
          try {
            const { model } = parseTable(source.text);
            applyMergesInPlace(table, model);
            this.bindings.set(table, { source, model });
          } catch {
            // Skip malformed tables silently.
          }
        }
        this.refreshOverlay();
      }

      private findSourceFor(
        table: HTMLTableElement,
        sources: TableSource[],
      ): TableSource | null {
        let pos: number;
        try {
          pos = this.view.posAtDOM(table);
        } catch {
          return null;
        }
        const line = this.view.state.doc.lineAt(Math.max(0, Math.min(pos, this.view.state.doc.length))).number - 1;
        // Pick the source block whose 0-indexed line range contains `line`,
        // falling back to the closest preceding block when the widget anchors
        // slightly outside its source range.
        let best: TableSource | null = null;
        for (const src of sources) {
          if (line >= src.fromLine && line <= src.toLine) return src;
          if (line >= src.fromLine && (!best || src.fromLine > best.fromLine)) best = src;
        }
        return best;
      }

      private handleMouseMove(e: MouseEvent) {
        if (this.drag) return;
        const target = e.target as HTMLElement | null;
        if (target?.closest(".tm-lp-col-handle")) {
          // Pointer is already over an overlay handle — keep the current table
          // binding alive instead of hiding and re-creating the handles.
          return;
        }
        const table = target?.closest("table");
        if (!(table instanceof HTMLTableElement) || !this.view.dom.contains(table)) {
          this.hideOverlay();
          return;
        }
        const binding = this.bindings.get(table);
        if (!binding) {
          this.hideOverlay();
          return;
        }
        this.hoverTable = table;
        this.renderHandles(table, binding.model, getRenderedWidths(table, binding.model));
      }

      private refreshOverlay() {
        if (this.drag) {
          this.renderDragState();
          return;
        }
        if (!this.hoverTable || !this.hoverTable.isConnected) {
          this.hideOverlay();
          return;
        }
        const binding = this.bindings.get(this.hoverTable);
        if (!binding) {
          this.hideOverlay();
          return;
        }
        this.renderHandles(this.hoverTable, binding.model, getRenderedWidths(this.hoverTable, binding.model));
      }

      private renderHandles(table: HTMLTableElement, model: TableModel, widths: number[]) {
        clearOverlayHandles(this.overlayEl);
        this.guideEl.classList.add("is-hidden");
        this.overlayEl.classList.add("is-visible");
        if (model.cols <= 1) return;
        const rect = table.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) {
          this.hideOverlay();
          return;
        }
        const edges = getColumnRightEdges(table, model, widths);
        for (let c = 0; c < model.cols; c++) {
          const x = edges[c];
          const handle = table.ownerDocument.createElement("div");
          handle.className = "tm-lp-col-handle";
          handle.style.left = `${x}px`;
          handle.style.top = `${rect.top}px`;
          handle.style.height = `${rect.height}px`;
          handle.dataset.col = String(c);
          handle.addEventListener("pointerdown", (e) => this.startDrag(e, table, model, c, widths));
          this.overlayEl.appendChild(handle);
        }
      }

      private startDrag(
        e: PointerEvent,
        table: HTMLTableElement,
        model: TableModel,
        col: number,
        widths: number[],
      ) {
        const binding = this.bindings.get(table);
        if (!binding) return;
        e.preventDefault();
        e.stopPropagation();
        this.drag = {
          table,
          source: binding.source,
          model: cloneModel(model),
          widths: widths.slice(),
          startWidths: widths.slice(),
          minWidths: new Array<number>(model.cols).fill(LP_MIN_COL_WIDTH),
          col,
          startX: e.clientX,
        };
        this.overlayEl.classList.add("is-dragging");
        this.guideEl.classList.remove("is-hidden");
        const doc = this.view.dom.ownerDocument;
        doc.addEventListener("pointermove", this.pointerMoveListener);
        doc.addEventListener("pointerup", this.pointerUpListener);
        this.renderDragState();
      }

      private handlePointerMove(e: PointerEvent) {
        if (!this.drag) return;
        const delta = e.clientX - this.drag.startX;
        const minWidth = this.drag.minWidths[this.drag.col] ?? LP_MIN_COL_WIDTH;
        const next = Math.max(minWidth, Math.round(this.drag.startWidths[this.drag.col] + delta));
        if (next === this.drag.widths[this.drag.col]) return;
        this.drag.widths[this.drag.col] = next;
        this.drag.model.colWidths = this.drag.widths.slice();
        applyColWidthsInPlace(this.drag.table, this.drag.model);
        this.renderDragState();
      }

      private handlePointerUp(_e: PointerEvent) {
        if (!this.drag) return;
        const drag = this.drag;
        const changed = !sameWidths(drag.startWidths, drag.widths);
        this.drag = null;
        this.overlayEl.classList.remove("is-dragging");
        const doc = this.view.dom.ownerDocument;
        doc.removeEventListener("pointermove", this.pointerMoveListener);
        doc.removeEventListener("pointerup", this.pointerUpListener);
        if (changed) {
          const next = cloneModel(drag.model);
          next.colWidths = drag.widths.slice();
          writeModelBack(this.view, drag.source, next, host.getOutputFormat());
          this.schedule();
        } else {
          this.refreshOverlay();
        }
      }

      private renderDragState() {
        if (!this.drag) return;
        const { table, model, widths, col } = this.drag;
        this.renderHandles(table, model, widths);
        const rect = table.getBoundingClientRect();
        const edges = getColumnRightEdges(table, model, widths);
        const x = edges[col] ?? rect.left;
        this.guideEl.style.left = `${x}px`;
        this.guideEl.style.top = `${rect.top}px`;
        this.guideEl.style.height = `${rect.height}px`;
        this.guideEl.classList.remove("is-hidden");
      }

      private hideOverlay() {
        if (this.drag) return;
        this.hoverTable = null;
        clearOverlayHandles(this.overlayEl);
        this.overlayEl.classList.remove("is-visible");
        this.guideEl.classList.add("is-hidden");
      }
    },
  );
}

function clearOverlayHandles(root: HTMLElement) {
  for (const handle of Array.from(root.querySelectorAll(".tm-lp-col-handle"))) handle.remove();
}

function getRenderedWidths(table: HTMLTableElement, model: TableModel): number[] {
  if (Array.isArray(model.colWidths) && model.colWidths.length === model.cols) {
    return model.colWidths.slice();
  }
  const widths = new Array<number>(model.cols).fill(0);
  const firstRow = table.rows[0];
  if (firstRow) {
    let col = 0;
    for (const cell of Array.from(firstRow.cells)) {
      const span = Math.max(1, cell.colSpan || 1);
      const part = cell.getBoundingClientRect().width / span;
      for (let i = 0; i < span && col + i < model.cols; i++) {
        widths[col + i] = Math.max(widths[col + i], Math.round(part));
      }
      col += span;
    }
  }
  const fallback = Math.max(LP_MIN_COL_WIDTH, Math.round(table.getBoundingClientRect().width / Math.max(1, model.cols)));
  return widths.map((w) => Math.max(LP_MIN_COL_WIDTH, w || fallback));
}

/**
 * Compute the actual visual x-coordinate of each column's right edge in the
 * currently rendered Live Preview table. This keeps overlay handles aligned
 * with the DOM the user sees instead of with idealized cumulative widths.
 *
 * For merged header cells we divide the rendered cell box evenly across its
 * colspan, which is consistent with the colgroup-driven fixed layout we apply
 * in LP and gives each logical column its own drag edge. Any column whose
 * edge can't be inferred from the DOM falls back to a cumulative-width
 * estimate so the overlay remains functional even on unusual widget layouts.
 */
function getColumnRightEdges(table: HTMLTableElement, model: TableModel, widths: number[]): number[] {
  const edges = new Array<number>(model.cols).fill(0);
  const fallback: number[] = [];
  let sum = table.getBoundingClientRect().left;
  for (let c = 0; c < model.cols; c++) {
    sum += widths[c];
    fallback.push(sum);
  }

  const row = Array.from(table.rows).find((tr) => tr.cells.length > 0);
  if (!row) return fallback;

  let logicalCol = 0;
  for (const cell of Array.from(row.cells)) {
    const span = Math.max(1, cell.colSpan || 1);
    const rect = cell.getBoundingClientRect();
    for (let i = 0; i < span && logicalCol + i < model.cols; i++) {
      edges[logicalCol + i] = rect.left + (rect.width * (i + 1)) / span;
    }
    logicalCol += span;
    if (logicalCol >= model.cols) break;
  }

  return edges.map((edge, idx) => (edge > 0 ? edge : fallback[idx]));
}

function sameWidths(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function writeModelBack(view: EditorView, source: TableSource, model: TableModel, format: OutputFormat) {
  const docLines = view.state.doc.toString().split(/\r?\n/);
  const range = expandWritebackRange(docLines, source.fromLine, source.toLine);
  const text = serialize(model, format);
  const from = view.state.doc.line(range.fromLine + 1).from;
  const to = view.state.doc.line(range.toLine + 1).to;
  view.dispatch({
    changes: { from, to, insert: text },
  });
}

/**
 * LP 拖拽回写前再次向上兜底扩展替换范围，确保旧的 colWidths/caption
 * 元数据不会留在表格上方，避免“拖一次后多出第二条注释”的情况。
 *
 * 这里的规则与阅读模式 postProcessor 的做法保持一致：
 *  - 可吸收紧邻表格上方的 colWidths / caption
 *  - 最多吸收它们与表头之间的 1 行空白
 *  - 不跨越普通正文 / separator，避免误吞上一张表
 */
function expandWritebackRange(
  lines: string[],
  fromLine: number,
  toLine: number,
): { fromLine: number; toLine: number } {
  let start = fromLine;
  let consumedBlank = false;
  while (start > 0) {
    const prev = lines[start - 1];
    if (isColWidthsLine(prev) || isCaptionLine(prev)) {
      start--;
      continue;
    }
    if (prev.trim() === "" && !consumedBlank && start - 1 > 0) {
      const prevPrev = lines[start - 2];
      const next = lines[start];
      if (
        next != null &&
        isStructuralTableLine(next) &&
        !isSeparatorLine(next) &&
        (isColWidthsLine(prevPrev) || isCaptionLine(prevPrev))
      ) {
        start--;
        consumedBlank = true;
        continue;
      }
    }
    break;
  }
  return { fromLine: start, toLine };
}

/**
 * Apply the model's merge structure to an already-rendered `<table>` without
 * touching cell content. Anchor cells receive their `rowspan` / `colspan`
 * attributes; placeholder cells are visually removed via the
 * `.tm-merge-placeholder` CSS class so the row/column geometry collapses
 * around them.
 */
function modelHasMerges(model: TableModel): boolean {
  for (const row of model.rows) {
    for (const cell of row) {
      if (!cell.isAnchor) return true;
      if (cell.rowspan > 1 || cell.colspan > 1) return true;
    }
  }
  return false;
}

function applyMergesInPlace(table: HTMLTableElement, model: TableModel): void {
  applyColWidthsInPlace(table, model);
  if (!modelHasMerges(model)) {
    // No merges — clean up any stale merge attributes from a previous pass
    // (e.g. the source was re-matched after an edit that removed merges).
    for (const td of Array.from(table.querySelectorAll<HTMLTableCellElement>("[data-tm-merge]"))) {
      td.removeAttribute("colspan");
      td.removeAttribute("rowspan");
      td.classList.remove("tm-merge-placeholder");
      delete td.dataset.tmMerge;
    }
    return;
  }
  const rows = Array.from(table.rows);
  const rowLimit = Math.min(rows.length, model.rows.length);
  for (let r = 0; r < rowLimit; r++) {
    const tr = rows[r];
    const cells = Array.from(tr.cells);
    if (!cells.length) continue;
    const colLimit = Math.min(cells.length, model.cols);
    for (let c = 0; c < colLimit; c++) {
      const modelCell = model.rows[r][c];
      const td = cells[c];
      if (!modelCell || !td) continue;
      if (modelCell.isAnchor) {
        if (modelCell.rowspan > 1) td.setAttribute("rowspan", String(modelCell.rowspan));
        else td.removeAttribute("rowspan");
        if (modelCell.colspan > 1) td.setAttribute("colspan", String(modelCell.colspan));
        else td.removeAttribute("colspan");
        td.classList.remove("tm-merge-placeholder");
        td.dataset.tmMerge = modelCell.rowspan > 1 || modelCell.colspan > 1 ? "anchor" : "";
        // Some Obsidian builds render raw `<br>` in a GFM table cell as plain
        // text instead of a real line break. Promote any literal `<br>` text
        // node to a real <br> element so multi-line cells (Excel paste, etc.)
        // visually break to a new line in Live Preview too.
        upgradeLiteralBrs(td);
      } else {
        td.classList.add("tm-merge-placeholder");
        td.dataset.tmMerge = "placeholder";
      }
    }
  }
}

/**
 * Apply persisted column widths to Live Preview's already-rendered table
 * without rebuilding the widget DOM. We keep the mutation surface narrow:
 * a single managed `<colgroup>` (tagged with `data-tm-colgroup="1"`) plus a
 * few inline table/cell styles. This is much lighter than wiping/recreating
 * rows, and in practice keeps CodeMirror's table widget stable while still
 * letting persisted widths show up in WYSIWYG mode.
 */
function applyColWidthsInPlace(table: HTMLTableElement, model: TableModel): void {
  const existing = table.querySelector<HTMLTableColElement>("colgroup[data-tm-colgroup='1']");
  const hasWidths = Array.isArray(model.colWidths) && model.colWidths.length === model.cols;
  if (!hasWidths) {
    existing?.remove();
    table.style.removeProperty("table-layout");
    table.style.removeProperty("width");
    table.style.removeProperty("min-width");
    table.style.removeProperty("max-width");
    for (const cell of Array.from(table.querySelectorAll<HTMLTableCellElement>("th, td"))) {
      cell.style.removeProperty("overflow-wrap");
      cell.style.removeProperty("word-break");
    }
    return;
  }

  const doc = table.ownerDocument;
  const colgroup = existing ?? doc.createElement("colgroup");
  if (!existing) {
    colgroup.dataset.tmColgroup = "1";
    table.insertBefore(colgroup, table.firstChild);
  }

  while (colgroup.children.length > model.cols) {
    colgroup.lastElementChild?.remove();
  }
  while (colgroup.children.length < model.cols) {
    colgroup.appendChild(doc.createElement("col"));
  }

  const cols = Array.from(colgroup.children) as HTMLTableColElement[];
  let totalWidth = 0;
  for (let c = 0; c < model.cols; c++) {
    const width = model.colWidths?.[c];
    if (width != null && Number.isFinite(width) && Number.isInteger(width)) {
      cols[c].style.width = `${width}px`;
      totalWidth += width;
    } else {
      cols[c].style.removeProperty("width");
    }
  }

  // In CodeMirror's Live Preview widget, `table-layout: fixed` combined with
  // `width: auto` can still end up visually stretched by the editor/theme,
  // which makes narrow persisted widths like 20px and 30px look identical.
  //
  // Force the widget table's own width to the exact pixel sum of the
  // persisted columns so each `<col>` width has a real layout box to occupy.
  // This keeps LP aligned with the stored metadata instead of letting the
  // editor pane redistribute the extra width.
  table.style.tableLayout = "fixed";
  table.style.width = `${Math.max(totalWidth, LP_MIN_COL_WIDTH * model.cols)}px`;
  table.style.minWidth = table.style.width;
  table.style.maxWidth = "none";
  for (const cell of Array.from(table.querySelectorAll<HTMLTableCellElement>("th, td"))) {
    cell.style.overflowWrap = "anywhere";
    cell.style.wordBreak = "break-word";
  }
}

/**
 * Walk all text nodes inside `el` and split any that contain a literal `<br>`
 * substring into [text, <br>, text] sequences. Idempotent: once the `<br>`
 * has been promoted to a real element, the text-node walker skips over it on
 * subsequent invocations and the function becomes a no-op.
 */
function upgradeLiteralBrs(el: HTMLElement): void {
  const doc = el.ownerDocument;
  if (!doc) return;
  const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const targets: Text[] = [];
  let node: Node | null = walker.nextNode();
  while (node) {
    const text = node as Text;
    if (/<br\s*\/?>/i.test(text.data)) targets.push(text);
    node = walker.nextNode();
  }
  for (const text of targets) {
    const pieces = text.data.split(/<br\s*\/?>/i);
    if (pieces.length === 1) continue;
    const parent = text.parentNode;
    if (!parent) continue;
    const frag = doc.createDocumentFragment();
    pieces.forEach((piece, idx) => {
      if (idx > 0) frag.appendChild(doc.createElement("br"));
      if (piece) frag.appendChild(doc.createTextNode(piece));
    });
    parent.replaceChild(frag, text);
  }
}

interface TableSource {
  text: string;
  /** 0-indexed line where the block starts in the document. */
  fromLine: number;
  /** 0-indexed inclusive line where the block ends. */
  toLine: number;
}

function collectTableSources(lines: string[]): TableSource[] {
  const blocks: TableSource[] = [];
  let buf: string[] = [];
  let bufStart = -1;
  let bufEnd = -1;
  let blanks = 0;
  let inTable = false;
  let hasSep = false;
  // Mirror the post-processor rule: allow at most one blank line between a
  // colWidths comment / caption and the header, so our standard serialized
  // form “colWidths + empty + header” is still one source block while ≥2
  // blanks always split neighbouring tables.
  let allowOneBlank = true;

  const flush = () => {
    while (buf.length && buf[buf.length - 1].trim() === "") {
      buf.pop();
      bufEnd--;
    }
    if (buf.length && hasSep && bufStart >= 0) {
      blocks.push({ text: buf.join("\n"), fromLine: bufStart, toLine: bufEnd });
    }
    buf = [];
    bufStart = -1;
    bufEnd = -1;
    blanks = 0;
    inTable = false;
    hasSep = false;
    allowOneBlank = true;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") {
      if (!inTable) continue;
      blanks++;
      if (blanks >= 2) {
        flush();
      } else if (allowOneBlank && i + 1 < lines.length) {
        const next = lines[i + 1];
        if (next != null && isStructuralTableLine(next) && !isSeparatorLine(next)) {
          buf.push(line);
          bufEnd = i;
          allowOneBlank = false;
          continue;
        }
        flush();
      } else {
        flush();
      }
      continue;
    }
    if (isStructuralTableLine(line)) {
      // A second separator line means a new table is starting — flush the
      // previous one. Pop any header line(s) that belong to the new table.
      if (isSeparatorLine(line) && hasSep) {
        // Count how many non-blank, non-separator lines at the end of buf
        // belong to the new table's header.
        let headerCount = 0;
        for (let j = buf.length - 1; j >= 0; j--) {
          if (buf[j].trim() === "" || isSeparatorLine(buf[j])) break;
          headerCount++;
        }
        const newHeaderLines = buf.splice(buf.length - headerCount, headerCount);
        // Also trim trailing blanks from old table
        while (buf.length && buf[buf.length - 1].trim() === "") {
          buf.pop();
          bufEnd--;
        }
        flush();
        // Re-derive bufStart from i: header lines precede separator at line i
        const headerStart = i - headerCount;
        for (let k = 0; k < newHeaderLines.length; k++) {
          if (!inTable) bufStart = headerStart + k;
          buf.push(newHeaderLines[k]);
          bufEnd = headerStart + k;
          inTable = true;
        }
        allowOneBlank = true;
      }
      if (!inTable) bufStart = i;
      buf.push(line);
      bufEnd = i;
      blanks = 0;
      allowOneBlank = true;
      inTable = true;
      if (isSeparatorLine(line)) hasSep = true;
      continue;
    }
    if (inTable) flush();
  }
  if (buf.length) flush();
  return blocks;
}
