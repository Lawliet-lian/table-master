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
import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import { isSeparatorLine, parseTable } from "../table/parser";
import { isCaptionLine, isColWidthsLine, isStructuralTableLine, isTableContextLine } from "../table/structural";
import { cloneModel, mergeAxisForCell, type TableModel } from "../table/model";
import { serialize, type OutputFormat } from "../table/serializer";

// Live Preview 单独使用更高的拖拽下限。阅读模式和网格编辑器继续沿用
// TableModel 的全局 MIN_COL_WIDTH，这样可以保持当前阅读模式“看起来挺好”的
// 现状，同时把 LP 交互最小宽度固定到用户要求的 33。
const LP_MIN_COL_WIDTH = 33;
const LP_DEBUG_URL = "http://127.0.0.1:7777/event";
const LP_DEBUG_SESSION = "lp-input-overlap";
const LP_DEBUG_RUN = "post-fix";
const LP_DEBUG_FILE = join(__dirname, ".dbg", `trae-debug-log-${LP_DEBUG_SESSION}.ndjson`);
const VIEW_DEBUG_IDS = new WeakMap<EditorView, number>();
let nextViewDebugId = 1;

// #region debug-point reporter
function reportLpDebug(
  hypothesisId: "A" | "B" | "C" | "D" | "E",
  location: string,
  msg: string,
  data: Record<string, unknown>,
): void {
  const event = {
    sessionId: LP_DEBUG_SESSION,
    runId: LP_DEBUG_RUN,
    hypothesisId,
    location,
    msg: `[DEBUG] ${msg}`,
    data,
    ts: Date.now(),
  };

  try {
    // 当前调试链路里，HTTP Debug Server 可能因为运行环境的本地回环限制而
    // 无法稳定收日志。这里先把每条事件落到插件目录下的 `.dbg/*.ndjson`，
    // 这样即使 HTTP 上报失败，我们仍然能保留完整运行时证据。
    mkdirSync(join(__dirname, ".dbg"), { recursive: true });
    appendFileSync(LP_DEBUG_FILE, `${JSON.stringify(event)}\n`, "utf8");
  } catch {
    // 本地调试落盘失败时不影响插件主流程，仍继续尝试 HTTP 上报。
  }

  fetch(LP_DEBUG_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event),
  }).catch(() => {});
}
// #endregion

// #region debug-point E:metrics-helpers
function getViewDebugId(view: EditorView): number {
  const existing = VIEW_DEBUG_IDS.get(view);
  if (existing != null) return existing;
  const created = nextViewDebugId++;
  VIEW_DEBUG_IDS.set(view, created);
  return created;
}

function summarizeElement(el: Element | null): string | null {
  if (!el) return null;
  const id = el.id ? `#${el.id}` : "";
  const className =
    el instanceof HTMLElement && typeof el.className === "string"
      ? el.className
          .split(/\s+/)
          .filter(Boolean)
          .slice(0, 3)
          .map((name) => `.${name}`)
          .join("")
      : "";
  return `${el.tagName}${id}${className}`;
}

function summarizeDomChain(el: Element | null, limit = 6): string[] {
  const chain: string[] = [];
  let current: Element | null = el;
  let depth = 0;
  while (current && depth < limit) {
    chain.push(summarizeElement(current) ?? current.tagName);
    current = current.parentElement;
    depth++;
  }
  return chain;
}

function getElementRectMetrics(el: Element | null): Record<string, number | null> | null {
  if (!(el instanceof Element)) return null;
  const rect = el.getBoundingClientRect();
  return {
    top: rect.top,
    bottom: rect.bottom,
    left: rect.left,
    right: rect.right,
    width: rect.width,
    height: rect.height,
  };
}

function elementAtRectCenter(doc: Document, el: Element | null): string | null {
  if (!(el instanceof Element)) return null;
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  return summarizeElement(doc.elementFromPoint(x, y));
}

function getViewMetrics(view: EditorView): Record<string, unknown> {
  const active = view.dom.ownerDocument.activeElement;
  const domRect = view.dom.getBoundingClientRect();
  const scrollRect = view.scrollDOM.getBoundingClientRect();
  const visibleRanges = view.visibleRanges;
  const lastVisibleRange = visibleRanges.length ? visibleRanges[visibleRanges.length - 1] : null;
  const win = view.dom.ownerDocument.defaultView ?? activeWindow;
  const domStyle = win.getComputedStyle(view.dom);
  const scrollStyle = win.getComputedStyle(view.scrollDOM);
  return {
    viewId: getViewDebugId(view),
    hasFocus: view.hasFocus,
    domIsConnected: view.dom.isConnected,
    scrollIsConnected: view.scrollDOM.isConnected,
    domDisplay: domStyle.display,
    domVisibility: domStyle.visibility,
    scrollDisplay: scrollStyle.display,
    scrollVisibility: scrollStyle.visibility,
    domClientHeight: view.dom.clientHeight,
    domScrollHeight: view.dom.scrollHeight,
    domTop: domRect.top,
    domBottom: domRect.bottom,
    domLeft: domRect.left,
    domRight: domRect.right,
    scrollClientHeight: view.scrollDOM.clientHeight,
    scrollScrollHeight: view.scrollDOM.scrollHeight,
    scrollTopRect: scrollRect.top,
    scrollBottomRect: scrollRect.bottom,
    scrollLeftRect: scrollRect.left,
    scrollRightRect: scrollRect.right,
    scrollTop: view.scrollDOM.scrollTop,
    visibleRangeCount: visibleRanges.length,
    visibleFrom: visibleRanges[0]?.from ?? null,
    visibleTo: lastVisibleRange?.to ?? null,
    activeTag: active?.tagName ?? null,
    activeSummary: active instanceof Element ? summarizeElement(active) : null,
    activeWithinView: active instanceof Node ? view.dom.contains(active) : false,
    activeWithinScroll: active instanceof Node ? view.scrollDOM.contains(active) : false,
  };
}

function getTableMetrics(table: HTMLTableElement): Record<string, number | null> {
  const rect = table.getBoundingClientRect();
  return {
    rows: table.rows.length,
    cells: table.querySelectorAll("td, th").length,
    height: rect.height,
    top: rect.top,
    bottom: rect.bottom,
    offsetHeight: table.offsetHeight,
    scrollHeight: table.scrollHeight,
    clientHeight: table.clientHeight,
  };
}
// #endregion

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
      settleTimer: number | null = null;
      lastDocChangeAt = 0;
      bindings = new WeakMap<HTMLTableElement, TableBinding>();
      hoverTable: HTMLTableElement | null = null;
      overlayEl: HTMLElement;
      guideEl: HTMLElement;
      drag: DragState | null = null;
      mouseMoveListener: (e: MouseEvent) => void;
      scrollListener: () => void;
      pointerMoveListener: (e: PointerEvent) => void;
      pointerUpListener: (e: PointerEvent) => void;
      tablePointerDownListener: (e: PointerEvent) => void;
      beforeInputListener: (e: InputEvent) => void;
      inputListener: (e: InputEvent) => void;
      compositionStartListener: (e: CompositionEvent) => void;
      compositionUpdateListener: (e: CompositionEvent) => void;
      compositionEndListener: (e: CompositionEvent) => void;
      interactingTable: HTMLTableElement | null = null;
      interactingTableUntil = 0;

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
        this.scrollListener = () => {
          // #region debug-point E:scroll-refresh
          reportLpDebug("E", "src/render/livePreview.ts:scrollListener", "scroll refresh", {
            ...getViewMetrics(this.view),
          });
          // #endregion
          this.refreshOverlay();
        };
        this.pointerMoveListener = (e) => this.handlePointerMove(e);
        this.pointerUpListener = (e) => this.handlePointerUp(e);
        // 用户决定采用“方案 A”后，编辑态不再维持真实合并 DOM，而是主动退回
        // 普通 MD 表格。这里在 pointerdown 的最早时机记录目标表格，并立即
        // 触发一次 schedule，这样切换会发生在真正输入之前，而不是等按键后
        // 才被动触发。
        this.tablePointerDownListener = (e) => this.handleTablePointerDown(e);
        // #region debug-point A:input-events
        this.beforeInputListener = (e) => this.handleDebugInputEvent("beforeinput", e);
        this.inputListener = (e) => this.handleDebugInputEvent("input", e);
        this.compositionStartListener = (e) => this.handleDebugCompositionEvent("compositionstart", e);
        this.compositionUpdateListener = (e) => this.handleDebugCompositionEvent("compositionupdate", e);
        this.compositionEndListener = (e) => this.handleDebugCompositionEvent("compositionend", e);
        // #endregion
        doc.addEventListener("mousemove", this.mouseMoveListener, { passive: true });
        view.scrollDOM.addEventListener("scroll", this.scrollListener, { passive: true });
        const win = doc.defaultView ?? activeWindow;
        win.addEventListener("scroll", this.scrollListener, { passive: true, capture: true });
        view.dom.addEventListener("pointerdown", this.tablePointerDownListener, true);
        // #region debug-point A:input-events-register
        view.dom.addEventListener("beforeinput", this.beforeInputListener, true);
        view.dom.addEventListener("input", this.inputListener, true);
        view.dom.addEventListener("compositionstart", this.compositionStartListener, true);
        view.dom.addEventListener("compositionupdate", this.compositionUpdateListener, true);
        view.dom.addEventListener("compositionend", this.compositionEndListener, true);
        // #endregion
        // 记录 ViewPlugin 生命周期，确认输入态和可见表格是否落在不同的
        // EditorView 实例上，以及这些实例是否仍然挂在当前文档里。
        reportLpDebug("E", "src/render/livePreview.ts:constructor", "plugin constructed", {
          ...getViewMetrics(this.view),
        });
        this.schedule();
      }

      update(u: ViewUpdate) {
        const doc = this.view.dom.ownerDocument;
        const tableEditorActive = isEmbeddedTableEditorActive(doc);
        // #region debug-point E:update
        if (u.docChanged || u.viewportChanged || u.geometryChanged || u.focusChanged) {
          reportLpDebug("E", "src/render/livePreview.ts:update", "view update", {
            docChanged: u.docChanged,
            viewportChanged: u.viewportChanged,
            geometryChanged: u.geometryChanged,
            focusChanged: u.focusChanged,
            tableEditorActive,
            hasTrackedInteractingTable:
              !!this.interactingTable?.isConnected && Date.now() < this.interactingTableUntil,
            ...getViewMetrics(this.view),
          });
        }
        // #endregion
        if (u.docChanged) {
          this.lastDocChangeAt = Date.now();
          // LP 编辑过程中避免立刻重跑合并布局。运行时证据表明，输入中的
          // DOM 重写会让整张表的行高/换行瞬时错位，出现文字掉到下一行、
          // 与下一行内容重叠、只显示半个字等问题。这里改为：
          // - 编辑中：只做 debounce settle，等用户停顿后再统一刷新
          // - 非编辑态：维持原先的即时刷新
          // 额外处理 Obsidian 的内嵌表格编辑器：它会创建一个仅一行高的
          // 临时 EditorView 来承接输入，而真正可见的 LP 表格仍在外层主
          // EditorView 中。若此时外层视图继续即时重跑 merge，会在输入中
          // 改动可见 widget，导致文字掉到第二行、半字、重叠等问题。
          // 因此只要检测到 `.table-editor` 处于激活态，就暂停即时刷新，
          // 只保留 settle 阶段的兜底刷新，等输入停顿/失焦后再恢复。
          if (!u.view.hasFocus && !tableEditorActive) this.schedule();
          this.scheduleSettle();
        } else if (u.viewportChanged || u.geometryChanged || u.focusChanged) {
          this.schedule();
        }
        if (u.geometryChanged || u.viewportChanged) this.refreshOverlay();
        if (u.focusChanged && !u.view.hasFocus && !this.drag) {
          this.hideOverlay();
          this.schedule();
        }
      }

      destroy() {
        reportLpDebug("E", "src/render/livePreview.ts:destroy", "plugin destroyed", {
          ...getViewMetrics(this.view),
        });
        if (this.timer != null) {
          // Use the editor's own window so the timer is cleared in popout
          // windows too. Bare `window` would only resolve to the main window
          // and trip obsidianmd's `prefer-active-doc` lint rule.
          const win = this.view.dom.ownerDocument.defaultView ?? activeWindow;
          win.clearTimeout(this.timer);
          this.timer = null;
        }
        if (this.settleTimer != null) {
          const win = this.view.dom.ownerDocument.defaultView ?? activeWindow;
          win.clearTimeout(this.settleTimer);
          this.settleTimer = null;
        }
        const doc = this.view.dom.ownerDocument;
        const win = doc.defaultView ?? activeWindow;
        doc.removeEventListener("mousemove", this.mouseMoveListener);
        this.view.scrollDOM.removeEventListener("scroll", this.scrollListener);
        win.removeEventListener("scroll", this.scrollListener, true);
        this.view.dom.removeEventListener("pointerdown", this.tablePointerDownListener, true);
        doc.removeEventListener("pointermove", this.pointerMoveListener);
        doc.removeEventListener("pointerup", this.pointerUpListener);
        // #region debug-point A:input-events-cleanup
        this.view.dom.removeEventListener("beforeinput", this.beforeInputListener, true);
        this.view.dom.removeEventListener("input", this.inputListener, true);
        this.view.dom.removeEventListener("compositionstart", this.compositionStartListener, true);
        this.view.dom.removeEventListener("compositionupdate", this.compositionUpdateListener, true);
        this.view.dom.removeEventListener("compositionend", this.compositionEndListener, true);
        // #endregion
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

      private scheduleSettle() {
        const win = this.view.dom.ownerDocument.defaultView ?? activeWindow;
        if (this.settleTimer != null) {
          win.clearTimeout(this.settleTimer);
        }
        this.settleTimer = win.setTimeout(() => {
          this.settleTimer = null;
          this.run();
        }, 320);
      }

      private run() {
        const doc = this.view.dom.ownerDocument;
        const tableEditorActive = isEmbeddedTableEditorActive(doc);
        const trackedEditingTable =
          this.interactingTable?.isConnected && Date.now() < this.interactingTableUntil
            ? this.interactingTable
            : null;
        const preserveEditingFlow =
          this.view.hasFocus && Date.now() - this.lastDocChangeAt < 180;
        const activeEditingTable = trackedEditingTable ?? findActiveEditingTable(doc);
        // #region debug-point B:run
        reportLpDebug("B", "src/render/livePreview.ts:run", "run apply merges pass", {
          hasFocus: this.view.hasFocus,
          preserveEditingFlow,
          tableEditorActive,
          sinceLastDocChange: Date.now() - this.lastDocChangeAt,
          hasActiveEditingTable: !!activeEditingTable,
          activeEditingTableMetrics: activeEditingTable ? getTableMetrics(activeEditingTable) : null,
          hasTrackedInteractingTable:
            !!this.interactingTable?.isConnected && Date.now() < this.interactingTableUntil,
          ...getViewMetrics(this.view),
        });
        // #endregion
        // #region debug-point E:table-editor-dom
        if (tableEditorActive || trackedEditingTable || activeEditingTable) {
          const embeddedEditorTable = findEmbeddedTableEditor(doc);
          reportLpDebug("E", "src/render/livePreview.ts:run", "table editor dom relationship", {
            tableEditorActive,
            embeddedEditorSummary: summarizeElement(embeddedEditorTable),
            embeddedEditorRect: getElementRectMetrics(embeddedEditorTable),
            embeddedEditorChain: summarizeDomChain(embeddedEditorTable),
            activeEditingTableSummary: summarizeElement(activeEditingTable),
            activeEditingTableRect: getElementRectMetrics(activeEditingTable),
            activeEditingTableChain: summarizeDomChain(activeEditingTable),
            trackedEditingTableSummary: summarizeElement(trackedEditingTable),
            trackedEditingTableRect: getElementRectMetrics(trackedEditingTable),
            trackedEditingTableChain: summarizeDomChain(trackedEditingTable),
            activeIsEmbeddedEditor: !!embeddedEditorTable && activeEditingTable === embeddedEditorTable,
            trackedIsEmbeddedEditor: !!embeddedEditorTable && trackedEditingTable === embeddedEditorTable,
            embeddedInsideTracked:
              !!embeddedEditorTable && !!trackedEditingTable && trackedEditingTable.contains(embeddedEditorTable),
            trackedInsideEmbedded:
              !!embeddedEditorTable && !!trackedEditingTable && embeddedEditorTable.contains(trackedEditingTable),
            embeddedInsideActive:
              !!embeddedEditorTable && !!activeEditingTable && activeEditingTable.contains(embeddedEditorTable),
            activeInsideEmbedded:
              !!embeddedEditorTable && !!activeEditingTable && embeddedEditorTable.contains(activeEditingTable),
            hitAtEmbeddedCenter: elementAtRectCenter(doc, embeddedEditorTable),
            hitAtTrackedCenter: elementAtRectCenter(doc, trackedEditingTable),
            hitAtActiveCenter: elementAtRectCenter(doc, activeEditingTable),
            ...getViewMetrics(this.view),
          });
        }
        // #endregion
        const tables = Array.from(this.view.dom.querySelectorAll<HTMLTableElement>("table"));
        // #region debug-point E:run-tables
        reportLpDebug("E", "src/render/livePreview.ts:run", "run table scan", {
          tableCount: tables.length,
          tableSummaries: tables.slice(0, 3).map((table, index) => ({
            index,
            ...getTableMetrics(table),
          })),
          ...getViewMetrics(this.view),
        });
        // #endregion
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
            const renderPlainEditingTable = shouldRenderPlainEditingTable(
              table,
              activeEditingTable,
              trackedEditingTable,
              tableEditorActive,
              this.view.hasFocus,
            );
            if (table.classList.contains("table-editor")) {
              // `table-editor` 是宿主真正承接输入的原生表格，因此要按焦点态
              // 分两套表现：
              // - 编辑中：只做最小 marker 同步，保留 `<` / `^^` 可见，但不
              //   改写当前输入层，避免再出现文字重叠；
              // - 失焦后：恢复真实合并渲染，让 LP 回到最终展示态。
              if (renderPlainEditingTable) {
                syncTableEditorMergeMarkersInPlace(table, model);
              } else {
                applyMergesInPlace(table, model, false);
              }
              this.bindings.set(table, { source, model });
              continue;
            }
            // #region debug-point D:active-table-freeze
            if (renderPlainEditingTable) {
              reportLpDebug("D", "src/render/livePreview.ts:run", "render plain editing table", {
                ...getTableMetrics(table),
                modelCols: model.cols,
                hasMerges: modelHasMerges(model),
                tableEditorActive,
                trackedEditingTableConnected: !!trackedEditingTable?.isConnected,
                ...getViewMetrics(this.view),
              });
            }
            // #endregion
            if (renderPlainEditingTable) {
              // 方案 A：当前表格处于编辑态时，LP 不再维持 rowspan/colspan
              // 的“真实合并”外观，而是主动清回普通 MD 表格，让 `<`、`^^`
              // 等源码标记直接显示出来。这样外层可见表格就不会再和
              // Obsidian 的内嵌表格编辑器争夺布局控制权。
              renderPlainMdTableInPlace(table);
            } else {
              applyMergesInPlace(table, model, preserveEditingFlow);
            }
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

      // #region debug-point A:input-events-methods
      private handleDebugInputEvent(kind: "beforeinput" | "input", e: InputEvent) {
        const target = e.target as Node | null;
        if (!target || !(target instanceof Node)) return;
        const host = target instanceof Element ? target.closest("td, th") : target.parentElement?.closest("td, th");
        if (!(host instanceof HTMLTableCellElement)) return;
        const table = host.closest("table");
        if (table instanceof HTMLTableElement) {
          this.interactingTable = table;
          this.interactingTableUntil = Date.now() + 1200;
        }
        const wrapper = host.querySelector(":scope > .table-cell-wrapper");
        const row = host.parentElement instanceof HTMLTableRowElement ? host.parentElement : null;
        const nextRow = row?.nextElementSibling instanceof HTMLTableRowElement ? row.nextElementSibling : null;
        reportLpDebug("A", `src/render/livePreview.ts:${kind}`, `table ${kind}`, {
          inputType: e.inputType ?? null,
          data: e.data ?? null,
          isComposing: e.isComposing ?? false,
          hostTag: host.tagName,
          hostText: host.textContent?.slice(0, 80) ?? "",
          hostRowspan: host.getAttribute("rowspan"),
          hostColspan: host.getAttribute("colspan"),
          hostMerge: host.dataset.tmMerge ?? null,
          hostMergeAxis: host.dataset.tmMergeAxis ?? null,
          activeTag: host.ownerDocument.activeElement?.tagName ?? null,
          wrapperTag: wrapper instanceof HTMLElement ? wrapper.tagName : null,
          wrapperClass: wrapper instanceof HTMLElement ? wrapper.className : null,
          wrapperHeight: wrapper instanceof HTMLElement ? wrapper.getBoundingClientRect().height : null,
          cellHeight: host.getBoundingClientRect().height,
          rowHeight: row?.getBoundingClientRect().height ?? null,
          nextRowHeight: nextRow?.getBoundingClientRect().height ?? null,
          trackFreezeMs: table instanceof HTMLTableElement ? Math.max(0, this.interactingTableUntil - Date.now()) : 0,
          ...getViewMetrics(this.view),
        });
      }

      private handleDebugCompositionEvent(
        kind: "compositionstart" | "compositionupdate" | "compositionend",
        e: CompositionEvent,
      ) {
        const target = e.target as Node | null;
        if (!target || !(target instanceof Node)) return;
        const host = target instanceof Element ? target.closest("td, th") : target.parentElement?.closest("td, th");
        if (!(host instanceof HTMLTableCellElement)) return;
        const table = host.closest("table");
        if (table instanceof HTMLTableElement) {
          this.interactingTable = table;
          this.interactingTableUntil = Date.now() + 1200;
        }
        reportLpDebug("A", `src/render/livePreview.ts:${kind}`, `table ${kind}`, {
          data: e.data ?? null,
          hostText: host.textContent?.slice(0, 80) ?? "",
          hostMerge: host.dataset.tmMerge ?? null,
          hostMergeAxis: host.dataset.tmMergeAxis ?? null,
          selectionAnchorNode: host.ownerDocument.getSelection()?.anchorNode?.nodeName ?? null,
          selectionAnchorOffset: host.ownerDocument.getSelection()?.anchorOffset ?? null,
          trackFreezeMs: table instanceof HTMLTableElement ? Math.max(0, this.interactingTableUntil - Date.now()) : 0,
          ...getViewMetrics(this.view),
        });
      }

      private handleTablePointerDown(e: PointerEvent) {
        const target = e.target as Node | null;
        if (!(target instanceof Node)) return;
        const table =
          target instanceof Element
            ? target.closest("table")
            : target.parentElement?.closest("table");
        if (!(table instanceof HTMLTableElement) || !this.view.dom.contains(table)) {
          // 点击表格外部时，尽快结束“编辑态普通表格”窗口，让失焦后的下一轮
          // run 能把可见表格恢复成真实合并外观。
          this.interactingTable = null;
          this.interactingTableUntil = 0;
          this.schedule();
          return;
        }
        // 记录用户即将编辑的可见 LP 表格。哪怕随后 Obsidian 切到那个
        // 21px 的内嵌 `table-editor`，我们仍然能知道应该把哪张可见表格
        // 退回为普通 MD 表格。
        this.interactingTable = table;
        this.interactingTableUntil = Date.now() + 4000;
        this.schedule();
      }
      // #endregion
    },
  );
}

function clearOverlayHandles(root: HTMLElement) {
  for (const handle of Array.from(root.querySelectorAll(".tm-lp-col-handle"))) handle.remove();
}

function findActiveEditingTable(doc: Document): HTMLTableElement | null {
  const active = doc.activeElement;
  if (active instanceof Element) {
    const fromActive = active.closest("table");
    if (fromActive instanceof HTMLTableElement) return fromActive;
  }
  const anchor = doc.getSelection()?.anchorNode ?? null;
  const anchorParent = anchor instanceof Element ? anchor : anchor?.parentElement ?? null;
  const fromSelection = anchorParent?.closest("table");
  return fromSelection instanceof HTMLTableElement ? fromSelection : null;
}

function isEmbeddedTableEditorActive(doc: Document): boolean {
  const active = doc.activeElement;
  if (active instanceof Element && active.closest("table.table-editor")) return true;
  const anchor = doc.getSelection()?.anchorNode ?? null;
  const anchorParent = anchor instanceof Element ? anchor : anchor?.parentElement ?? null;
  return !!anchorParent?.closest("table.table-editor");
}

function findEmbeddedTableEditor(doc: Document): HTMLTableElement | null {
  const active = doc.activeElement;
  if (active instanceof Element) {
    const fromActive = active.closest("table.table-editor");
    if (fromActive instanceof HTMLTableElement) return fromActive;
  }
  const anchor = doc.getSelection()?.anchorNode ?? null;
  const anchorParent = anchor instanceof Element ? anchor : anchor?.parentElement ?? null;
  const fromSelection = anchorParent?.closest("table.table-editor");
  if (fromSelection instanceof HTMLTableElement) return fromSelection;
  return doc.querySelector("table.table-editor");
}

function shouldRenderPlainEditingTable(
  table: HTMLTableElement,
  activeEditingTable: HTMLTableElement | null,
  trackedEditingTable: HTMLTableElement | null,
  tableEditorActive: boolean,
  viewHasFocus: boolean,
): boolean {
  // 这里的目标不是“只要进入过编辑态，就一直保持源码表格”，而是明确区分：
  // - 正在编辑 / 仍持有焦点：显示源码占位效果（`<` / `^^`）
  // - 鼠标失焦 / 退出编辑：恢复真实合并渲染
  //
  // 因此 tracked/active 只能在“仍处于编辑窗口期”时生效；一旦视图失焦，
  // 就必须回到 merge 渲染，不能再让编辑态残留。
  const editingWindowOpen = tableEditorActive || viewHasFocus;
  if (!editingWindowOpen) return false;
  if (trackedEditingTable && table === trackedEditingTable) return true;
  if (activeEditingTable && table === activeEditingTable) return true;
  return false;
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

function clearRenderedMergePresentation(table: HTMLTableElement): void {
  // 编辑态普通表格需要把我们所有“真实合并外观”都撤掉，包括：
  // - rowspan / colspan
  // - placeholder 隐藏类
  // - merge 语义 data 属性
  // - 纵向居中的内联样式
  // - wrapper 的展示态高度修正
  //
  // 这里按全表遍历，而不是只扫 `[data-tm-merge]`，是因为上一轮渲染可能
  // 已经留下原生表格属性；全量清理更直接，也更接近“回到普通 MD 表格”的
  // 最终目标。
  for (const td of Array.from(table.querySelectorAll<HTMLTableCellElement>("td, th"))) {
    td.removeAttribute("colspan");
    td.removeAttribute("rowspan");
    td.classList.remove("tm-merge-placeholder");
    delete td.dataset.tmMerge;
    delete td.dataset.tmMergeAxis;
    delete td.dataset.tmEditorMarker;
    td.style.removeProperty("vertical-align");
    syncLpMergedCellWrapperAlignment(td, "", false);
  }
}

function clearLpColWidthPresentation(table: HTMLTableElement): void {
  // 编辑态普通表格不再保留 LP 展示态的固定列宽策略。否则：
  // - `table-layout: fixed`
  // - 表格总宽强绑到列宽之和
  // - `overflow-wrap: anywhere` / `word-break: break-word`
  //
  // 会继续影响 Obsidian 内嵌表格编辑器的文本布局，哪怕我们已经把
  // `<` / `^^` 渲染回普通表格，也仍然可能出现输入换行挤压或文字重叠。
  table.querySelector<HTMLTableColElement>("colgroup[data-tm-colgroup='1']")?.remove();
  table.style.removeProperty("table-layout");
  table.style.removeProperty("width");
  table.style.removeProperty("min-width");
  table.style.removeProperty("max-width");
  for (const cell of Array.from(table.querySelectorAll<HTMLTableCellElement>("th, td"))) {
    cell.style.removeProperty("overflow-wrap");
    cell.style.removeProperty("word-break");
  }
}

function renderPlainMdTableInPlace(table: HTMLTableElement): void {
  // 方案 A 下，编辑态优先追求“像 Obsidian 原生普通表格那样稳定可编辑”，
  // 不再保留 LP 展示态的固定列宽/强制换行策略。这样 `<` / `^^` / `||`
  // 等源码标记会直接显示出来，同时把布局控制权交还给表格编辑器本身。
  clearLpColWidthPresentation(table);
  clearRenderedMergePresentation(table);
}

function isEditingThisCellInDocument(td: HTMLTableCellElement): boolean {
  const doc = td.ownerDocument;
  const active = doc.activeElement;
  const selectionAnchor = doc.getSelection()?.anchorNode ?? null;
  return (!!active && td.contains(active)) || (!!selectionAnchor && td.contains(selectionAnchor));
}

function syncTableEditorCellText(td: HTMLTableCellElement, text: string): void {
  const wrapper = td.firstElementChild;
  if (wrapper instanceof HTMLElement && wrapper.classList.contains("table-cell-wrapper")) {
    // 这里明确只给占位格回填一个纯文本标记，不插 HTML，不改当前活动输入层，
    // 以尽量降低对宿主原生 table-editor 的干扰。
    wrapper.textContent = text;
    return;
  }
  td.textContent = text;
}

function syncTableEditorMergeMarkersInPlace(table: HTMLTableElement, model: TableModel): void {
  // `table.table-editor` 已经是宿主维护的“普通矩形表格”，我们不再把它改造成
  // 真实 merge DOM。这里只做最小同步：
  // - 清掉插件可能残留的 merge 展示属性
  // - 只把非 anchor 占位格的源码标记（`<` / `^^`）补回去
  //
  // 这样既能维持当前“不重叠”的输入稳定性，也能把用户需要看到的占位语义
  // 重新显示出来。
  clearLpColWidthPresentation(table);
  const rows = Array.from(table.rows);
  const rowLimit = Math.min(rows.length, model.rows.length);
  for (let r = 0; r < rowLimit; r++) {
    const tr = rows[r];
    const cells = Array.from(tr.cells);
    const colLimit = Math.min(cells.length, model.cols);
    for (let c = 0; c < colLimit; c++) {
      const td = cells[c];
      const modelCell = model.rows[r][c];
      if (!td || !modelCell) continue;
      td.removeAttribute("colspan");
      td.removeAttribute("rowspan");
      td.classList.remove("tm-merge-placeholder");
      delete td.dataset.tmMerge;
      delete td.dataset.tmMergeAxis;
      delete td.dataset.tmEditorMarker;
      td.style.removeProperty("vertical-align");
      if (!modelCell.isAnchor) {
        if (isEditingThisCellInDocument(td)) {
          // 当前光标就在这个占位格里时，仍然让宿主原生编辑层直接显示真实文本，
          // 避免出现“正在编辑同一格，却看到伪元素 marker”的错位感。
          syncTableEditorCellText(td, modelCell.raw);
        } else {
          // 非活动占位格改用 `data-* + CSS ::before` 显示 marker。这样即使宿主
          // 在相邻单元格获得焦点时重新整理了 wrapper 文本，左侧 `< / ^^` 也
          // 不会跟着一起消失。
          td.dataset.tmEditorMarker = modelCell.raw;
          syncTableEditorCellText(td, "");
        }
      }
    }
  }
}

function applyMergesInPlace(
  table: HTMLTableElement,
  model: TableModel,
  preserveEditingFlow = false,
): void {
  const beforeMetrics = getTableMetrics(table);
  // #region debug-point B:apply-merges
  reportLpDebug("B", "src/render/livePreview.ts:applyMergesInPlace", "apply merges in place", {
    preserveEditingFlow,
    rows: table.rows.length,
    cols: model.cols,
    hasMerges: modelHasMerges(model),
    ...beforeMetrics,
  });
  // #endregion
  applyColWidthsInPlace(table, model);
  if (!modelHasMerges(model)) {
    // 没有合并结构时，统一走全表清理逻辑，保证所有残留 merge 外观都能
    // 被撤干净。这样也让“普通表格”和“编辑态方案 A”的回退路径保持一致。
    clearRenderedMergePresentation(table);
    // #region debug-point E:apply-merges-after-clean
    reportLpDebug("E", "src/render/livePreview.ts:applyMergesInPlace", "apply merges cleanup completed", {
      preserveEditingFlow,
      hasMerges: false,
      beforeHeight: beforeMetrics.height,
      afterHeight: getTableMetrics(table).height,
      ...getTableMetrics(table),
    });
    // #endregion
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
        const mergeAxis = mergeAxisForCell(modelCell);
        if (modelCell.rowspan > 1) td.setAttribute("rowspan", String(modelCell.rowspan));
        else td.removeAttribute("rowspan");
        if (modelCell.colspan > 1) td.setAttribute("colspan", String(modelCell.colspan));
        else td.removeAttribute("colspan");
        td.classList.remove("tm-merge-placeholder");
        if (mergeAxis) {
          // LP 里不重建单元格，只是给现有 DOM 补属性；这里补上统一的
          // `data-tm-merge-axis`，让它和阅读模式 / 网格编辑器共享同一套样式语义。
          td.dataset.tmMerge = "anchor";
          td.dataset.tmMergeAxis = mergeAxis;
          // 纵向合并在 LP 中需要直接写内联 `vertical-align`，而且这里显式用
          // `!important`，这样即使主题或 Obsidian 自带的 LP 表格规则也写了
          // 更强的选择器 / `!important`，纵向合并锚点依然会按预期垂直居中。
          // 纯横向合并则保持默认表现。
          if (mergeAxis === "row" || mergeAxis === "both") {
            td.style.setProperty("vertical-align", "middle", "important");
          } else {
            td.style.removeProperty("vertical-align");
          }
          // LP 的真实可视内容在 `.table-cell-wrapper` 里；若它被编辑器样式拉成
          // 与整格同高，`td` 的垂直居中会失效。这里把 wrapper 高度收回到内容
          // 本身，让 `table-cell` 级别的 `vertical-align: middle` 生效。
          syncLpMergedCellWrapperAlignment(td, mergeAxis, preserveEditingFlow);
        } else {
          delete td.dataset.tmMerge;
          delete td.dataset.tmMergeAxis;
          td.style.removeProperty("vertical-align");
          syncLpMergedCellWrapperAlignment(td, "", preserveEditingFlow);
        }
        // Some Obsidian builds render raw `<br>` in a GFM table cell as plain
        // text instead of a real line break. Promote any literal `<br>` text
        // node to a real <br> element so multi-line cells (Excel paste, etc.)
        // visually break to a new line in Live Preview too.
        upgradeLiteralBrs(td);
      } else {
        td.classList.add("tm-merge-placeholder");
        td.dataset.tmMerge = "placeholder";
        delete td.dataset.tmMergeAxis;
        td.style.removeProperty("vertical-align");
        syncLpMergedCellWrapperAlignment(td, "", preserveEditingFlow);
      }
    }
  }
  // #region debug-point E:apply-merges-after
  reportLpDebug("E", "src/render/livePreview.ts:applyMergesInPlace", "apply merges completed", {
    preserveEditingFlow,
    hasMerges: true,
    beforeHeight: beforeMetrics.height,
    afterHeight: getTableMetrics(table).height,
    ...getTableMetrics(table),
  });
  // #endregion
}

function syncLpMergedCellWrapperAlignment(
  td: HTMLTableCellElement,
  mergeAxis: ReturnType<typeof mergeAxisForCell>,
  preserveEditingFlow = false,
): void {
  const wrapper = td.firstElementChild;
  if (!(wrapper instanceof HTMLElement) || !wrapper.classList.contains("table-cell-wrapper")) return;
  const doc = td.ownerDocument;
  const active = doc?.activeElement;
  const selection = doc?.getSelection();
  const selectionAnchor = selection?.anchorNode ?? null;
  const isEditingThisCell =
    (!!active && td.contains(active)) ||
    (!!selectionAnchor && td.contains(selectionAnchor));
  // #region debug-point C:wrapper-sync
  reportLpDebug("C", "src/render/livePreview.ts:syncLpMergedCellWrapperAlignment", "sync merged wrapper", {
    mergeAxis,
    preserveEditingFlow,
    isEditingThisCell,
    tdText: td.textContent?.slice(0, 80) ?? "",
    tdRowspan: td.getAttribute("rowspan"),
    tdColspan: td.getAttribute("colspan"),
    tdHeight: td.getBoundingClientRect().height,
    wrapperHeight: wrapper.getBoundingClientRect().height,
    activeTag: active?.tagName ?? null,
    selectionAnchorNode: selectionAnchor?.nodeName ?? null,
  });
  // #endregion
  if (mergeAxis === "row" || mergeAxis === "both") {
    // 编辑态优先交还给 LP 原生布局。否则 wrapper 的展示态高度修正会和
    // 当前输入中的可编辑层打架，造成文本临时“掉到单元格下面”的现象。
    if (preserveEditingFlow || isEditingThisCell) {
      wrapper.style.removeProperty("width");
      wrapper.style.removeProperty("height");
      wrapper.style.removeProperty("min-height");
      wrapper.style.removeProperty("max-height");
      wrapper.style.removeProperty("position");
      wrapper.style.removeProperty("top");
      wrapper.style.removeProperty("transform");
      return;
    }
    // 运行时证据表明：LP 的 `td` 已经正确拿到了 `vertical-align: middle`，
    // 但 `.table-cell-wrapper` 被主题/编辑器样式拉成了与整格等高，导致
    // 单元格垂直居中失效。这里不再改动 wrapper 的布局方式，只把它的高度
    // 收回到内容本身，让 `td` 的 table-cell 垂直居中重新生效。
    wrapper.style.width = "100%";
    wrapper.style.setProperty("height", "auto", "important");
    wrapper.style.setProperty("min-height", "0", "important");
    wrapper.style.setProperty("max-height", "max-content", "important");
    wrapper.style.removeProperty("position");
    wrapper.style.removeProperty("top");
    wrapper.style.removeProperty("transform");
  } else {
    wrapper.style.removeProperty("display");
    wrapper.style.removeProperty("width");
    wrapper.style.removeProperty("height");
    wrapper.style.removeProperty("min-height");
    wrapper.style.removeProperty("max-height");
    wrapper.style.removeProperty("position");
    wrapper.style.removeProperty("top");
    wrapper.style.removeProperty("transform");
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
    clearLpColWidthPresentation(table);
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

  function shouldKeepBodyBreak(blankLine: number): boolean {
    let j = blankLine + 1;
    let sawSep = false;
    let sawBody = false;
    while (j < lines.length) {
      const peek = lines[j];
      if (peek == null || peek.trim() === "") break;
      if (isSeparatorLine(peek)) {
        sawSep = true;
        break;
      }
      if (!isTableContextLine(peek)) break;
      sawBody = true;
      j++;
    }
    return sawBody && !sawSep;
  }

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
      } else if (!hasSep) {
        if (allowOneBlank && i + 1 < lines.length) {
          const next = lines[i + 1];
          if (next != null && isStructuralTableLine(next) && !isSeparatorLine(next)) {
            buf.push(line);
            bufEnd = i;
            allowOneBlank = false;
            continue;
          }
        }
        flush();
      } else if (shouldKeepBodyBreak(i)) {
        // 只有 blank 下方继续跟着“纯正文行”时，才把它当作同一张表里的 tbody break。
        // 下方若是新的注释/caption，则应归属于下一张表，而不是反向影响当前表。
        buf.push(line);
        bufEnd = i;
        continue;
      } else {
        flush();
      }
      continue;
    }
    if (isStructuralTableLine(line)) {
      if (hasSep && (isColWidthsLine(line) || isCaptionLine(line))) {
        // `tm-colwidths` / caption 只允许作为表格上方的 leading metadata。
        // 一旦当前表已经进入正文区域，再遇到元数据，说明它属于下一张表。
        flush();
      }
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
