// Shared logic for taking a TableModel and applying it to an existing
// (Obsidian-rendered) HTML table. Used by both the reading-view
// post-processor and the live-preview view plugin.

import type { App, Component, MarkdownRenderer as MdRenderer } from "obsidian";
import { MarkdownRenderer } from "obsidian";
import { MIN_COL_WIDTH, TableModel } from "../table/model";

// 阅读模式布局算法版本。只要阅读模式的宽度归一化 / 再分配策略发生变化，
// 升这个版本就能让已有 DOM 在下次 post-processor 运行时重新渲染，
// 而不会被旧的 `data-tm-rendered` 签名错误复用。
const READING_LAYOUT_VERSION = "reading-v2";

export interface ApplyOptions {
  sourcePath: string;
  component: Component;
  app?: App;
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
  const renderSignature = modelSignature(model, table);
  if (table.dataset.tmRendered === renderSignature) return;

  // Snapshot styles so we can re-apply them once we replace the body.
  const className = table.className;
  table.innerHTML = "";
  table.className = className;
  table.classList.add("tm-rendered");

  // Build new nodes through the table's own ownerDocument so the markup
  // also lives in the right document tree when the markdown view is in a
  // popout window. obsidianmd's `prefer-active-doc` lint rule additionally
  // forbids referencing the bare `document` global.
  const doc = table.ownerDocument;

  // Emit a <colgroup> up front so per-column widths can be applied before
  // any cell content is painted. This matches standard HTML table rendering and
  // avoids content jumping during layout. Only write explicit widths when the
  // caller actually declared colWidths; otherwise we leave the browser to its
  // own auto-width strategy (matches "undefined = never set widths" semantics).
  const readingColWidths = normalizeReadingColWidths(model, table, doc);
  if (readingColWidths && readingColWidths.length === model.cols) {
    const colgroup = doc.createElement("colgroup");
    for (let c = 0; c < model.cols; c++) {
      const col = doc.createElement("col");
      const width = readingColWidths[c];
      if (Number.isFinite(width) && Number.isInteger(width)) {
        col.style.width = `${width}px`;
      }
      colgroup.appendChild(col);
    }
    table.appendChild(colgroup);
  }

  if (model.caption) {
    const cap = doc.createElement("caption");
    cap.textContent = model.caption.text;
    table.appendChild(cap);
  }

  if (model.headerRows > 0) {
    const thead = doc.createElement("thead");
    for (let r = 0; r < model.headerRows; r++) {
      thead.appendChild(rowToTr(doc, model, r, "th", opts));
    }
    table.appendChild(thead);
  }

  if (model.rows.length > model.headerRows) {
    const breaks = new Set(model.tbodyBreaks ?? []);
    let tbody: HTMLTableSectionElement | null = null;
    for (let r = model.headerRows; r < model.rows.length; r++) {
      if (!tbody || breaks.has(r)) {
        tbody = doc.createElement("tbody");
        table.appendChild(tbody);
      }
      tbody.appendChild(rowToTr(doc, model, r, "td", opts));
    }
  }

  // Inline markdown rendering happens after structure is in place so async
  // renderers don't fight with us removing/reordering nodes.
  if (opts.renderInline) await renderCellsInline(table, model, opts);

  table.dataset.tmRendered = renderSignature;
}

/**
 * 阅读模式的目标不是像 LP 那样“像素级忠实回放拖拽结果”，而是优先保证可读性。
 *
 * 方案 A 的落地规则：
 * - `tm-colwidths` 仍然是主输入，保留用户拖拽得到的宽度意图；
 * - 但如果某一列的持久化宽度过窄，已经不足以让当前文本稳定单行显示，
 *   阅读模式会把它抬高到“最小可读宽度”；
 * - 这样前几列不会被压到两行，而备注这类长列仍然保持“明显更宽”的倾向。
 *
 * 注意：这里只影响 reading view 的 `<colgroup>` 输出，不改写 model，也不影响
 * Live Preview / Grid Editor 的交互语义。
 */
function normalizeReadingColWidths(
  model: TableModel,
  table: HTMLTableElement,
  doc: Document,
): number[] | null {
  if (!model.colWidths || model.colWidths.length !== model.cols) return null;
  const metrics = estimateReadingColumnMetrics(model, doc);
  const preferred = model.colWidths.map((width, idx) => {
    const safe = Number.isFinite(width) && Number.isInteger(width) ? width : MIN_COL_WIDTH;
    // 短字段列优先保障单行可读宽度；长文本列则保留用户宽度意图，
    // 但允许后续在阅读模式里优先被压缩并换行。
    return metrics[idx]?.flexible
      ? safe
      : Math.max(safe, metrics[idx]?.minReadable ?? MIN_COL_WIDTH);
  });

  const available = getReadingAvailableWidth(table);
  if (!available || preferred.reduce((sum, width) => sum + width, 0) <= available) {
    return preferred;
  }

  const next = preferred.slice();
  // 第 1 轮：优先压缩长文本列（如备注 / 备注2），把空间还给短字段列。
  shrinkColumns(
    next,
    metrics.map((m) => m.flexible),
    metrics.map((m) => m.minFlexibleWidth),
    available,
  );
  // 第 2 轮：如果容器依然装不下，再允许所有列向各自的最小可读宽度收缩。
  shrinkColumns(
    next,
    metrics.map(() => true),
    metrics.map((m) => m.minReadable),
    available,
  );
  return next;
}

/**
 * 估算阅读模式下每一列“至少多宽才不会太难看”。
 *
 * 这里不尝试做浏览器级别的精确排版模拟，而是用一套稳定、成本低的近似：
 * - 读取所有 anchor cell 的原始文本；
 * - 按 header / body 两种字体权重估算单行宽度；
 * - 把单元格左右 padding、边框和一点安全余量加回去；
 * - 对 colspan 单元格把需求均摊到对应逻辑列上。
 *
 * 这样可以明显改善像“64|72|64|1699”这类极端数据在阅读模式下把前几列压成
 * 两行的情况，同时不需要引入一整套新的比例布局算法。
 */
interface ReadingColumnMetrics {
  minReadable: number;
  minFlexibleWidth: number;
  flexible: boolean;
}

function estimateReadingColumnMetrics(model: TableModel, doc: Document): ReadingColumnMetrics[] {
  const metrics = new Array<ReadingColumnMetrics>(model.cols).fill(null as never).map(() => ({
    minReadable: MIN_COL_WIDTH,
    minFlexibleWidth: MIN_COL_WIDTH,
    flexible: false,
  }));
  const ctx = doc.createElement("canvas").getContext("2d");
  if (!ctx) return metrics;

  const win = doc.defaultView;
  const rootStyle = win?.getComputedStyle(doc.documentElement);
  const bodyStyle = doc.body ? win?.getComputedStyle(doc.body) : null;
  const fontSize = bodyStyle?.fontSize || "16px";
  const fontFamily = bodyStyle?.fontFamily || "sans-serif";
  const bodyWeight = bodyStyle?.fontWeight || "400";
  const headerWeight = rootStyle?.getPropertyValue("--font-semibold").trim() || "600";
  const horizontalInset = estimateHorizontalCellInset(rootStyle);
  const headerWidths = new Array<number>(model.cols).fill(MIN_COL_WIDTH);
  const bodyWidths = new Array<number>(model.cols).fill(MIN_COL_WIDTH);
  const longestBodyWidths = new Array<number>(model.cols).fill(0);
  const longestBodyChars = new Array<number>(model.cols).fill(0);

  for (let r = 0; r < model.rows.length; r++) {
    for (let c = 0; c < model.cols; c++) {
      const cell = model.rows[r][c];
      if (!cell?.isAnchor) continue;

      // 只看最长的可见行即可；阅读模式的目标是避免“表头/短值被压成两行”，
      // 不需要为了长备注列去无限抬高最小宽度。
      const text = cell.raw
        .replace(/\\\n/g, "\n")
        .split("\n")
        .map((line) => line.replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .sort((a, b) => b.length - a.length)[0] ?? "";

      if (!text) continue;

      const weight = r < model.headerRows ? headerWeight : bodyWeight;
      ctx.font = `${weight} ${fontSize} ${fontFamily}`;
      const span = Math.max(1, cell.colspan || 1);
      const textWidth = ctx.measureText(text).width;
      const estimated = Math.max(
        MIN_COL_WIDTH,
        Math.ceil((textWidth + horizontalInset + 12) / span),
      );

      for (let i = 0; i < span && c + i < model.cols; i++) {
        if (r < model.headerRows) {
          headerWidths[c + i] = Math.max(headerWidths[c + i], estimated);
        } else {
          bodyWidths[c + i] = Math.max(bodyWidths[c + i], estimated);
          longestBodyWidths[c + i] = Math.max(longestBodyWidths[c + i], estimated);
          longestBodyChars[c + i] = Math.max(longestBodyChars[c + i], text.length);
        }
      }
    }
  }

  for (let c = 0; c < model.cols; c++) {
    const header = headerWidths[c];
    const body = bodyWidths[c];
    const longest = longestBodyWidths[c];
    const chars = longestBodyChars[c];
    // 经验规则：正文存在明显长文本时，这一列视为“可换行的长文本列”。
    // 这类列在阅读模式下可以优先压缩，把空间让给任务/负责人/操作人这类
    // 更适合保持单行的短字段列。
    const flexible =
      chars >= 12 ||
      longest >= Math.max(header * 1.9, 220);
    metrics[c] = {
      minReadable: Math.max(MIN_COL_WIDTH, header, flexible ? Math.min(body, header + 48) : body),
      minFlexibleWidth: Math.max(MIN_COL_WIDTH, header),
      flexible,
    };
  }

  return metrics;
}

/**
 * 读取 reading view 单元格的水平额外开销（padding + border）。
 *
 * 这里优先尊重主题传入的 `--table-cell-padding`，没有时回退到当前插件样式里的
 * `6px 12px`。额外再加上左右边框 2px 的常见开销，让估算结果更接近真实视觉宽度。
 */
function estimateHorizontalCellInset(rootStyle: CSSStyleDeclaration | null | undefined): number {
  const padding = rootStyle?.getPropertyValue("--table-cell-padding").trim() || "6px 12px";
  const parts = padding.split(/\s+/).filter(Boolean);
  const values = parts
    .map((part) => Number.parseFloat(part))
    .filter((num) => Number.isFinite(num));
  if (!values.length) return 26;
  const horizontal =
    values.length === 1 ? values[0] * 2 :
    values.length === 2 ? values[1] * 2 :
    values.length === 3 ? values[1] * 2 :
    values[1] + values[3];
  return Math.ceil(horizontal + 2);
}

function getReadingAvailableWidth(table: HTMLTableElement): number {
  const host =
    table.parentElement?.closest(".markdown-preview-sizer, .markdown-reading-view, .markdown-preview-view")
    ?? table.parentElement;
  const width = host?.getBoundingClientRect().width ?? table.getBoundingClientRect().width;
  return Math.max(0, Math.floor(width));
}

function shrinkColumns(
  widths: number[],
  canShrink: boolean[],
  minimums: number[],
  targetTotal: number,
): void {
  let total = widths.reduce((sum, width) => sum + width, 0);
  if (total <= targetTotal) return;

  for (let pass = 0; pass < 3 && total > targetTotal; pass++) {
    const shrinkable: number[] = [];
    let capacity = 0;
    for (let i = 0; i < widths.length; i++) {
      if (!canShrink[i]) continue;
      const room = widths[i] - Math.max(MIN_COL_WIDTH, minimums[i] ?? MIN_COL_WIDTH);
      if (room > 0) {
        shrinkable.push(i);
        capacity += room;
      }
    }
    if (!shrinkable.length || capacity <= 0) return;

    const overflow = total - targetTotal;
    let reduced = 0;
    for (const idx of shrinkable) {
      const min = Math.max(MIN_COL_WIDTH, minimums[idx] ?? MIN_COL_WIDTH);
      const room = widths[idx] - min;
      if (room <= 0) continue;
      const cut = Math.min(room, Math.ceil((overflow * room) / capacity));
      widths[idx] -= cut;
      reduced += cut;
    }
    if (reduced <= 0) return;
    total -= reduced;
  }
}

function rowToTr(
  doc: Document,
  model: TableModel,
  r: number,
  tag: "th" | "td",
  opts: ApplyOptions,
): HTMLTableRowElement {
  const tr = doc.createElement("tr");
  for (let c = 0; c < model.cols; c++) {
    const cell = model.rows[r][c];
    if (!cell.isAnchor) continue;
    const td = doc.createElement(tag);
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
        if (idx > 0) td.appendChild(doc.createElement("br"));
        td.appendChild(doc.createTextNode(piece));
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
      // Newer Obsidian versions expose `render(app, md, el, path, component)`;
      // older ones `renderMarkdown(md, el, path, component)`.
      const newRender = (renderer as unknown as { render?: (...args: unknown[]) => Promise<unknown> }).render;
      const oldRender = (renderer as unknown as { renderMarkdown?: (...args: unknown[]) => Promise<unknown> }).renderMarkdown;
      if (typeof newRender === "function" && opts.app) {
        await newRender.call(renderer, opts.app, text, td, opts.sourcePath, opts.component);
        unwrapTrailingParagraph(td);
      } else if (typeof oldRender === "function") {
        await oldRender.call(renderer, text, td, opts.sourcePath, opts.component);
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
function modelSignature(model: TableModel, table: HTMLTableElement): string {
  const parts: string[] = [
    String(model.headerRows),
    String(model.cols),
    JSON.stringify(model.tbodyBreaks ?? []),
    model.caption ? `${model.caption.text}|${model.caption.label ?? ""}` : "",
    // Include colWidths explicitly so that “only the widths were edited” is
    // still considered a new signature; otherwise the post-processor would
    // early-exit and the new <colgroup> would never be painted.
    JSON.stringify(model.colWidths ?? []),
    readingEnvironmentSignature(table),
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

/**
 * 把“阅读模式环境”折叠进签名里，避免出现下面这种情况：
 * - markdown 源码没变；
 * - 但用户从 LP 切到阅读模式、调整了 pane 宽度，或我们升级了阅读模式布局算法；
 * - 旧的 `data-tm-rendered` 仍然命中，导致 reading view 直接跳过重渲染。
 *
 * 这里不记录精确像素宽度，而是用分桶值降低抖动：只有阅读区宽度跨过一个桶时，
 * 才认为布局环境发生了足够大的变化，值得重新渲染。
 */
function readingEnvironmentSignature(table: HTMLTableElement): string {
  const available = getReadingAvailableWidth(table);
  const widthBucket = Math.max(0, Math.round(available / 32));
  return `${READING_LAYOUT_VERSION}|w${widthBucket}`;
}
