// Modal grid editor. Renders the current TableModel as an interactive HTML
// table. Cells are contenteditable; multi-cell selection enables Merge / Split
// buttons. On confirmation the modified model is passed back via a callback.

import { App, Modal, Notice, setIcon, setTooltip } from "obsidian";
import {
  TableModel,
  anchorOf,
  cloneModel,
  DEFAULT_COL_WIDTH,
  MIN_COL_WIDTH,
} from "../table/model";
import * as ops from "../table/ops";
import { t } from "../i18n";

interface CellPos {
  r: number;
  c: number;
}

export class GridEditorModal extends Modal {
  private model: TableModel;
  private readonly originalModel: TableModel;
  private readonly onSubmit: (m: TableModel) => void;
  private selectedCells: Set<string>;
  private dragging: boolean;
  private dragStart: CellPos | null;
  private gridEl: HTMLTableElement | null;
  private boundMouseUp: () => void;

  // --- Column width resize state (stage 4, only lives inside the modal) ---
  /**
   * The widths that the modal operates on. We mirror `model.colWidths` here
   * so every pointer drag can mutate the in-memory widths and repaint, but
   * the surrounding Markdown file is *not* touched until the user confirms
   * via the “应用 / OK” button. This follows the plan's stage-4 constraint
   * “only the OK button writes to Markdown”.
   */
  private colWidths: number[];
  /** True while a column-width drag is in effect. */
  private resizingCol: number | null;
  /** Initial clientX at the start of a column resize gesture. */
  private resizeStartX: number;
  /** Initial pixel width of the column being resized (before clamping). */
  private resizeStartWidth: number;
  /** The `pointermove` / `pointerup` handlers attached during a resize drag. */
  private boundResizeMove: ((e: PointerEvent) => void) | null;
  private boundResizeUp: ((e: PointerEvent) => void) | null;

  constructor(app: App, model: TableModel, onSubmit: (m: TableModel) => void) {
    super(app);
    this.model = cloneModel(model);
    this.originalModel = cloneModel(model);
    this.onSubmit = onSubmit;
    this.selectedCells = new Set<string>();
    this.dragging = false;
    this.dragStart = null;
    this.gridEl = null;
    this.boundMouseUp = () => this.handleMouseUp();
    this.modalEl.addClass("tm-modal");

    // Initialise / normalise column widths. Stage 1 intentionally keeps
    // `model.colWidths` as `undefined` for historical notes to keep the diff
    // noise low, but once the user opens the grid editor we guarantee a
    // concrete numeric array is present so the renderer + resize handles can
    // operate without extra null checks. Missing entries are filled with
    // DEFAULT_COL_WIDTH; oversized / non-finite entries are clamped to the
    // allowed range. Length is forced equal to `model.cols` so ops never
    // desync.
    const existing = Array.isArray(this.model.colWidths)
      ? this.model.colWidths.slice(0, this.model.cols)
      : [];
    while (existing.length < this.model.cols) existing.push(DEFAULT_COL_WIDTH);
    this.colWidths = existing.map((w) => {
      const num = Number.isFinite(w) ? (w as number) : DEFAULT_COL_WIDTH;
      return Math.max(MIN_COL_WIDTH, Math.round(num));
    });
    // Persist the normalised array back onto `this.model` so subsequent calls
    // to applyOp/merge/etc through the modal always operate on a model that
    // already has colWidths, which keeps op-level undefined guards simple.
    this.model.colWidths = this.colWidths.slice();

    // Resize event handlers bound once so we can consistently add/remove them
    // from the modal's ownerDocument. Both are null safe during onClose even
    // if no drag ever started.
    this.boundResizeMove = (e) => this.handleResizeMove(e);
    this.boundResizeUp = (e) => this.handleResizeUp(e);
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    // The dimension suffix doubles as a quick sanity check: if the title says
    // "1 × N" but the source clearly had more columns, the upstream parse /
    // locate is the culprit, not the renderer.
    titleEl.setText(`${t("modal.title")}  (${this.model.rows.length} × ${this.model.cols})`);
    contentEl.empty();

    this.renderToolbar(contentEl);
    const wrap = contentEl.createDiv({ cls: "tm-grid-wrap" });
    this.renderGrid(wrap);
    contentEl.createDiv({ cls: "tm-hint", text: t("modal.hint") });
    this.renderActions(contentEl);
  }

  onClose(): void {
    // Use the modal's own ownerDocument so the listener is removed from the
    // same document we attached it on (popout-window aware). obsidianmd's
    // `prefer-active-doc` lint rule forbids the bare `document` global.
    const doc = this.contentEl.ownerDocument;
    doc.removeEventListener("mouseup", this.boundMouseUp);
    if (this.boundResizeMove) doc.removeEventListener("pointermove", this.boundResizeMove);
    if (this.boundResizeUp) doc.removeEventListener("pointerup", this.boundResizeUp);
    this.contentEl.empty();
  }

  // --- Rendering ---

  private renderToolbar(parent: HTMLElement): void {
    const bar = parent.createDiv({ cls: "tm-grid-toolbar" });
    const mkBtn = (label: string, fn: () => void): HTMLButtonElement => {
      const b = bar.createEl("button");
      b.setText(label);
      b.addEventListener("click", fn);
      return b;
    };
    const mkIconBtn = (icon: string, tip: string, fn: () => void): HTMLButtonElement => {
      const b = bar.createEl("button", { cls: "tm-grid-icon-btn" });
      setIcon(b, icon);
      setTooltip(b, tip);
      b.setAttribute("aria-label", tip);
      b.addEventListener("click", fn);
      return b;
    };

    mkBtn(t("modal.merge"), () => this.mergeSelection());
    mkBtn(t("modal.split"), () => this.splitSelection());
    mkIconBtn("arrow-up", t("cmd.insertRowAbove"), () => {
      const row = this.selectionBounds()?.top ?? 0;
      this.applyOp((m) => ops.insertRow(m, row, "above"));
    });
    mkIconBtn("arrow-down", t("cmd.insertRowBelow"), () => {
      const row = this.selectionBounds()?.bottom ?? this.model.rows.length - 1;
      this.applyOp((m) => ops.insertRow(m, row, "below"));
    });
    mkIconBtn("arrow-left", t("cmd.insertColLeft"), () => {
      const col = this.selectionBounds()?.left ?? 0;
      this.applyOp((m) => ops.insertCol(m, col, "left"));
    });
    mkIconBtn("arrow-right", t("cmd.insertColRight"), () => {
      const col = this.selectionBounds()?.right ?? this.model.cols - 1;
      this.applyOp((m) => ops.insertCol(m, col, "right"));
    });
    mkBtn(t("modal.delRow"), () => {
      const row = this.firstSelected()?.r ?? this.model.rows.length - 1;
      this.applyOp((m) => ops.deleteRow(m, row));
    });
    mkBtn(t("modal.delCol"), () => {
      const col = this.firstSelected()?.c ?? this.model.cols - 1;
      this.applyOp((m) => ops.deleteCol(m, col));
    });
    mkBtn(t("modal.alignLeft"), () => this.alignSelection("left"));
    mkBtn(t("modal.alignCenter"), () => this.alignSelection("center"));
    mkBtn(t("modal.alignRight"), () => this.alignSelection("right"));
  }

  /**
   * Return the bounding rectangle of the current selection, expanded to
   * cover any cells whose rowspan/colspan extends past the selected anchor.
   * Returns `null` when nothing is selected.
   */
  private selectionBounds(): { top: number; bottom: number; left: number; right: number } | null {
    if (!this.selectedCells.size) return null;
    let top = Number.POSITIVE_INFINITY,
      bottom = -1,
      left = Number.POSITIVE_INFINITY,
      right = -1;
    for (const k of this.selectedCells) {
      const [r, c] = k.split(":").map(Number);
      const anchor = this.model.rows[r]?.[c];
      if (!anchor) continue;
      const er = r + (anchor.rowspan - 1);
      const ec = c + (anchor.colspan - 1);
      if (r < top) top = r;
      if (c < left) left = c;
      if (er > bottom) bottom = er;
      if (ec > right) right = ec;
    }
    if (bottom < 0 || right < 0) return null;
    return { top, bottom, left, right };
  }

  private renderGrid(parent: HTMLElement): void {
    parent.empty();
    const table = parent.createEl("table", { cls: "tm-grid" });
    this.gridEl = table;
    // Emit a <colgroup> with inline widths so the visual layout exactly
    // reflects the in-memory `this.colWidths` that the user is editing.
    // Without this, the browser would auto-size columns and the drag handles
    // would not match where the user actually drags.
    const colgroup = table.createEl("colgroup");
    for (let c = 0; c < this.model.cols; c++) {
      const col = colgroup.createEl("col");
      col.style.width = `${this.colWidths[c]}px`;
    }

    for (let r = 0; r < this.model.rows.length; r++) {
      const tr = table.createEl("tr");
      for (let c = 0; c < this.model.cols; c++) {
        const cell = this.model.rows[r][c];
        if (!cell.isAnchor) continue;
        const isHeaderRow = r < this.model.headerRows;
        const td = tr.createEl(isHeaderRow ? "th" : "td");
        if (cell.rowspan > 1) td.setAttr("rowspan", String(cell.rowspan));
        if (cell.colspan > 1) td.setAttr("colspan", String(cell.colspan));
        td.dataset.r = String(r);
        td.dataset.c = String(c);

        const align = this.model.aligns[c] ?? "none";
        if (align !== "none") td.style.textAlign = align;

        const edit = td.createDiv({ cls: "tm-cell-edit" });
        edit.contentEditable = "true";
        edit.spellcheck = false;
        edit.setText(cell.raw);
        edit.addEventListener("input", () => {
          cell.raw = edit.innerText;
        });
        edit.addEventListener("keydown", (e) => this.onCellKey(e, r, c));

        td.addEventListener("mousedown", (e) => this.handleCellMouseDown(e, r, c));
        td.addEventListener("mouseenter", (e) => this.handleCellMouseEnter(e, r, c));

        if (this.selectedCells.has(this.key(r, c))) td.addClass("tm-selected");

        // Only the LAST header row receives the visible resize handle strip
        // at its right edge; this keeps the grid compact while still letting
        // every column be resized. When headerRows === 0 we skip handles
        // entirely — an unusual case but we degrade gracefully instead of
        // crashing or rendering detached strips.
        if (isHeaderRow && r === this.model.headerRows - 1) {
          // Map the column C (anchor col) to the last visual column that
          // this anchor cell spans, because the handle must live at the
          // right edge of the cell. For single-column cells this equals c.
          const lastColIdx = c + (cell.colspan - 1);
          // Never attach a handle for the very last column's right edge;
          // there is nothing there to resize and it would sit on the modal
          // chrome. We only draw handles between columns 0..cols-2.
          if (lastColIdx < this.model.cols - 1) {
            const handle = td.createDiv({ cls: "tm-col-resizer" });
            setTooltip(handle, t("modal.resizeCol"));
            handle.setAttribute("role", "separator");
            handle.setAttribute("aria-label", t("modal.resizeCol"));
            handle.dataset.col = String(lastColIdx);
            handle.addEventListener("pointerdown", (e) => this.startResize(e, lastColIdx));
          }
        }
      }
    }
    // Pair with the removeEventListener in onClose; both use the modal's
    // ownerDocument so the listener is correctly scoped to the same window.
    this.contentEl.ownerDocument.addEventListener("mouseup", this.boundMouseUp);
  }

  // --- Column width resizing (stage 4; only OK button writes back) ---

  /**
   * Begin a column-width drag on the resize handle next to column `col`.
   * We capture the pointer on the handle element and listen to pointermove/up
   * on the modal's ownerDocument so the drag continues even when the pointer
   * leaves the handle / table surface.
   */
  private startResize(e: PointerEvent, col: number): void {
    if (col < 0 || col >= this.model.cols - 1) return;
    if (!this.boundResizeMove || !this.boundResizeUp) return;
    e.preventDefault();
    e.stopPropagation();
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture?.(e.pointerId);
    this.resizingCol = col;
    this.resizeStartX = e.clientX;
    this.resizeStartWidth = Number(this.colWidths[col]);
    this.gridEl?.classList.add("tm-col-resizing");
    const doc = this.contentEl.ownerDocument;
    doc.addEventListener("pointermove", this.boundResizeMove);
    doc.addEventListener("pointerup", this.boundResizeUp, { once: false });
  }

  private handleResizeMove(e: PointerEvent): void {
    if (this.resizingCol == null) return;
    const delta = e.clientX - this.resizeStartX;
    const next = Math.max(MIN_COL_WIDTH, Math.round(this.resizeStartWidth + delta));
    if (this.colWidths[this.resizingCol] === next) return;
    this.colWidths[this.resizingCol] = next;
    // Reflect the new width immediately onto the existing <colgroup> so the
    // user sees the table grow/shrink in real time during the drag instead of
    // waiting for renderGrid() — rebuilding the whole DOM mid-drag would lose
    // pointer capture, flicker and feel sluggish.
    const cols = this.gridEl?.querySelectorAll<HTMLTableColElement>("colgroup > col");
    if (cols && cols[this.resizingCol]) {
      cols[this.resizingCol].style.width = `${next}px`;
    }
  }

  private handleResizeUp(e: PointerEvent): void {
    if (this.resizingCol == null) return;
    const target = e.currentTarget as HTMLElement;
    target?.releasePointerCapture?.(e.pointerId);
    this.gridEl?.classList.remove("tm-col-resizing");
    const doc = this.contentEl.ownerDocument;
    if (this.boundResizeMove) doc.removeEventListener("pointermove", this.boundResizeMove);
    if (this.boundResizeUp) doc.removeEventListener("pointerup", this.boundResizeUp);
    // Copy the in-memory widths back onto the model so when OK is pressed the
    // serializer will emit them. We intentionally do NOT call
    // `applyOp`/`renderGrid` here because the width was already painted on
    // the live <colgroup>, and re-building the DOM would flicker.
    this.model.colWidths = this.colWidths.slice();
    this.resizingCol = null;
  }

  private renderActions(parent: HTMLElement): void {
    const bar = parent.createDiv({ cls: "tm-grid-actions" });
    const cancel = bar.createEl("button", { text: t("modal.cancel") });
    cancel.addEventListener("click", () => this.close());
    const ok = bar.createEl("button", { cls: "mod-cta", text: t("modal.ok") });
    ok.addEventListener("click", () => {
      this.onSubmit(this.model);
      this.close();
    });
  }

  // --- Selection ---

  private key(r: number, c: number): string {
    return `${r}:${c}`;
  }

  private firstSelected(): CellPos | null {
    if (!this.selectedCells.size) return null;
    const first = this.selectedCells.values().next().value as string | undefined;
    if (!first) return null;
    const [r, c] = first.split(":").map(Number);
    return { r, c };
  }

  private clearSelection(): void {
    this.selectedCells.clear();
    this.gridEl?.querySelectorAll(".tm-selected").forEach((el) => el.classList.remove("tm-selected"));
  }

  private addToSelection(r: number, c: number): void {
    // Resolve to anchor (so clicking a placeholder selects its anchor cell)
    const a = anchorOf(this.model, r, c);
    const k = this.key(a.r, a.c);
    if (this.selectedCells.has(k)) return;
    this.selectedCells.add(k);
    const td = this.gridEl?.querySelector(`[data-r="${a.r}"][data-c="${a.c}"]`);
    td?.classList.add("tm-selected");
  }

  private selectRange(a: CellPos, b: CellPos): void {
    this.clearSelection();
    const top = Math.min(a.r, b.r);
    const bottom = Math.max(a.r, b.r);
    const left = Math.min(a.c, b.c);
    const right = Math.max(a.c, b.c);
    for (let r = top; r <= bottom; r++) {
      for (let c = left; c <= right; c++) {
        this.addToSelection(r, c);
      }
    }
  }

  private handleCellMouseDown(e: MouseEvent, r: number, c: number): void {
    if ((e.target as HTMLElement).classList.contains("tm-cell-edit") && e.detail === 0) return;
    if (e.shiftKey && this.selectedCells.size > 0) {
      const first = this.firstSelected();
      if (first) this.selectRange(first, { r, c });
      return;
    }
    this.dragging = true;
    this.dragStart = { r, c };
    this.clearSelection();
    this.addToSelection(r, c);
  }

  private handleCellMouseEnter(_e: MouseEvent, r: number, c: number): void {
    if (!this.dragging || !this.dragStart) return;
    this.selectRange(this.dragStart, { r, c });
  }

  private handleMouseUp(): void {
    this.dragging = false;
  }

  // --- Cell key handling ---

  private onCellKey(e: KeyboardEvent, r: number, c: number): void {
    if (e.key === "Tab") {
      e.preventDefault();
      const dir = e.shiftKey ? -1 : 1;
      const next = this.nextCell(r, c, dir);
      if (next) this.focusCell(next.r, next.c);
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const next = this.nextRowCell(r, c);
      if (next) this.focusCell(next.r, next.c);
    }
  }

  private nextCell(r: number, c: number, dir: 1 | -1): CellPos | null {
    let nr = r;
    let nc = c + dir;
    while (nr >= 0 && nr < this.model.rows.length) {
      while (nc >= 0 && nc < this.model.cols) {
        if (this.model.rows[nr][nc].isAnchor) return { r: nr, c: nc };
        nc += dir;
      }
      nr += dir;
      nc = dir === 1 ? 0 : this.model.cols - 1;
    }
    return null;
  }

  private nextRowCell(r: number, c: number): CellPos | null {
    let nr = r + 1;
    while (nr < this.model.rows.length) {
      if (this.model.rows[nr][c]?.isAnchor) return { r: nr, c };
      nr++;
    }
    return null;
  }

  private focusCell(r: number, c: number): void {
    const el = this.gridEl?.querySelector<HTMLElement>(`[data-r="${r}"][data-c="${c}"] .tm-cell-edit`);
    el?.focus();
  }

  // --- Operations ---

  private applyOp(fn: (m: TableModel) => TableModel): void {
    this.model = fn(this.model);
    this.selectedCells.clear();
    // After ops that may insert / delete / move columns we must re-sync the
    // modal's own `colWidths` mirror with `model.colWidths`. The ops layer
    // already handles the lifetime (insertCol inserts DEFAULT_COL_WIDTH etc.)
    // when the model already has colWidths, which the constructor guarantees.
    // We still clamp + pad defensively here so a half-initialised model
    // (e.g. through future changes) can never break the UI renderer.
    const widths = Array.isArray(this.model.colWidths)
      ? this.model.colWidths.slice(0, this.model.cols)
      : [];
    while (widths.length < this.model.cols) widths.push(DEFAULT_COL_WIDTH);
    this.colWidths = widths.map((w) => {
      const num = Number.isFinite(w) ? (w as number) : DEFAULT_COL_WIDTH;
      return Math.max(MIN_COL_WIDTH, Math.round(num));
    });
    this.model.colWidths = this.colWidths.slice();
    if (this.gridEl?.parentElement) {
      this.renderGrid(this.gridEl.parentElement);
    }
  }

  private mergeSelection(): void {
    if (this.selectedCells.size < 2) return;
    let top = Number.POSITIVE_INFINITY,
      bottom = -1,
      left = Number.POSITIVE_INFINITY,
      right = -1;
    for (const k of this.selectedCells) {
      const [r, c] = k.split(":").map(Number);
      const anchor = this.model.rows[r][c];
      const er = r + (anchor.rowspan - 1);
      const ec = c + (anchor.colspan - 1);
      if (r < top) top = r;
      if (c < left) left = c;
      if (er > bottom) bottom = er;
      if (ec > right) right = ec;
    }
    // Validate: every cell inside the bounding rectangle must already be in
    // the selection (resolved to its anchor) so we don't accidentally engulf
    // unrelated cells.
    if (top < this.model.headerRows && bottom >= this.model.headerRows) {
      new Notice(t("notice.invalidMerge"));
      return;
    }
    this.applyOp((m) => ops.mergeRange(m, top, left, bottom, right));
  }

  private splitSelection(): void {
    const first = this.firstSelected();
    if (!first) return;
    this.applyOp((m) => ops.splitCell(m, first.r, first.c));
  }

  private alignSelection(align: "left" | "center" | "right"): void {
    if (!this.selectedCells.size) return;
    const cols = new Set<number>();
    for (const k of this.selectedCells) cols.add(parseInt(k.split(":")[1], 10));
    this.applyOp((m) => {
      let next = m;
      for (const c of cols) next = ops.setColAlign(next, c, align);
      return next;
    });
  }

  // Undo button hook — restore initial model
  resetModel(): void {
    this.model = cloneModel(this.originalModel);
    this.selectedCells.clear();
    if (this.gridEl?.parentElement) this.renderGrid(this.gridEl.parentElement);
  }
}
