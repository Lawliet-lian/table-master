// Pure data layer for tables. Has no Obsidian dependencies so it is fully unit-testable.

export type Align = "left" | "center" | "right" | "none";
export type MergeAxis = "row" | "col" | "both";

// 列宽持久化的默认与边界常量，阶段一先只在数据层定义。
// 注：像素宽度统一为正整数，渲染层可在后续阶段使用这些常量做归一化。
//
// 这里的最小宽度是“全局硬下限”：
// - 阅读模式应用 colgroup 时会参考它过滤非法宽度；
// - 网格编辑器拖拽时会把列宽 clamp 到这个值以上；
// - Live Preview overlay 拖拽时也会用它作为最终兜底。
//
// 用户当前希望让窄列（例如“编号”）可以继续缩小，所以把下限从 80 调整到 20。
// 这样三条渲染/编辑链路会保持一致，不会出现“LP 能拖到 20，但网格编辑器又弹回 80”
// 之类的语义分叉。
export const MIN_COL_WIDTH = 20;
export const DEFAULT_COL_WIDTH = 160;

/**
 * Logical cell. The grid is "expanded": every (row, col) position has a cell.
 * Anchor cells are the visible ones; non-anchor cells are placeholders that
 * point back to their anchor and serialize as `^^` (rowspan extension) or `<`
 * (colspan extension).
 */
export interface Cell {
  /** Raw markdown text inside the cell (without surrounding pipes). */
  raw: string;
  /** True when this position is the top-left of a merged region or a normal cell. */
  isAnchor: boolean;
  /** Row offset back to anchor. 0 when this cell is itself an anchor. */
  anchorRowOffset: number;
  /** Col offset back to anchor. */
  anchorColOffset: number;
  /** Span values are only meaningful on anchor cells. */
  rowspan: number;
  colspan: number;
}

/**
 * 把 anchor cell 的跨度转换成样式层可消费的“合并方向”语义。
 *
 * 这样渲染层和样式层就不需要各自重复写
 * `rowspan > 1 && colspan > 1 ? ...`
 * 这类判断了。三条链路统一使用这个函数后：
 * - 阅读模式重建 DOM；
 * - Live Preview 原地补属性；
 * - 网格编辑器实时绘制；
 * 都会产出一致的 `data-tm-merge-axis` 标记。
 */
export function mergeAxisForCell(cell: Pick<Cell, "rowspan" | "colspan">): MergeAxis | "" {
  const hasRowMerge = cell.rowspan > 1;
  const hasColMerge = cell.colspan > 1;
  if (hasRowMerge && hasColMerge) return "both";
  if (hasRowMerge) return "row";
  if (hasColMerge) return "col";
  return "";
}

export interface TableCaption {
  text: string;
  label?: string;
}

export interface TableModel {
  /** rows[r][c] */
  rows: Cell[][];
  /** Per-column alignment, length === cols. */
  aligns: Align[];
  /** Number of leading rows that are header rows. GFM tables always have exactly 1. */
  headerRows: number;
  /** Total number of columns (computed from header). */
  cols: number;
  caption?: TableCaption;
  tbodyBreaks: number[];
  /**
   * 可选：每列的显式像素宽度。
   * 当数组存在时长度必须等于 cols；值为像素整数，且不小于 MIN_COL_WIDTH。
   * undefined 表示该表没有被用户显式设置过列宽，渲染层应回退到自动宽度。
   */
  colWidths?: number[];
}

/** Build a normal anchor cell. */
export function makeAnchor(raw = ""): Cell {
  return {
    raw,
    isAnchor: true,
    anchorRowOffset: 0,
    anchorColOffset: 0,
    rowspan: 1,
    colspan: 1,
  };
}

/** Build a merge-up placeholder (`^^`). */
export function makeMergeUp(rowOffset: number, colOffset = 0): Cell {
  return {
    raw: "^^",
    isAnchor: false,
    anchorRowOffset: rowOffset,
    anchorColOffset: colOffset,
    rowspan: 0,
    colspan: 0,
  };
}

/** Build a merge-left placeholder (`<`). */
export function makeMergeLeft(colOffset: number, rowOffset = 0): Cell {
  return {
    raw: "",
    isAnchor: false,
    anchorRowOffset: rowOffset,
    anchorColOffset: colOffset,
    rowspan: 0,
    colspan: 0,
  };
}

/** Get the true anchor (r,c) for the cell at (r,c) by chasing the placeholder
 * chain. For anchors returns itself. */
export function anchorOf(model: TableModel, r: number, c: number): { r: number; c: number } {
  let cur = model.rows[r]?.[c];
  let safety = (model.rows.length + 1) * (model.cols + 1);
  while (cur && !cur.isAnchor && safety-- > 0) {
    const nr = r - cur.anchorRowOffset;
    const nc = c - cur.anchorColOffset;
    if (nr === r && nc === c) break;
    if (nr < 0 || nc < 0) break;
    r = nr;
    c = nc;
    cur = model.rows[r]?.[c];
  }
  return { r, c };
}

/** Deep clone a model. */
export function cloneModel(m: TableModel): TableModel {
  return {
    rows: m.rows.map((row) => row.map((cell) => ({ ...cell }))),
    aligns: [...m.aligns],
    headerRows: m.headerRows,
    cols: m.cols,
    caption: m.caption ? { ...m.caption } : undefined,
    tbodyBreaks: [...(m.tbodyBreaks ?? [])],
    // 列宽数组为 number[]，浅拷贝即可，同时保持 undefined 语义不变。
    colWidths: m.colWidths ? [...m.colWidths] : undefined,
  };
}

/**
 * Recompute rowspan/colspan on every anchor cell by scanning placeholders.
 * Mutates the model in place.
 */
export function recomputeSpans(m: TableModel): void {
  // Reset spans on anchors
  for (let r = 0; r < m.rows.length; r++) {
    for (let c = 0; c < m.cols; c++) {
      const cell = m.rows[r]?.[c];
      if (cell && cell.isAnchor) {
        cell.rowspan = 1;
        cell.colspan = 1;
      }
    }
  }
  // Walk placeholders and chase chains back to the true anchor, then bump spans
  for (let r = 0; r < m.rows.length; r++) {
    for (let c = 0; c < m.cols; c++) {
      const cell = m.rows[r]?.[c];
      if (!cell || cell.isAnchor) continue;
      const a = anchorOf(m, r, c);
      const anchor = m.rows[a.r]?.[a.c];
      if (!anchor || !anchor.isAnchor) continue;
      const desiredRowspan = r - a.r + 1;
      const desiredColspan = c - a.c + 1;
      if (desiredRowspan > anchor.rowspan) anchor.rowspan = desiredRowspan;
      if (desiredColspan > anchor.colspan) anchor.colspan = desiredColspan;
    }
  }
}

/** Build an empty model with given dims. Single header row, aligns default to none. */
export function emptyModel(rows: number, cols: number): TableModel {
  const r = Math.max(rows, 2);
  const c = Math.max(cols, 1);
  const grid: Cell[][] = [];
  for (let i = 0; i < r; i++) {
    const row: Cell[] = [];
    for (let j = 0; j < c; j++) row.push(makeAnchor(""));
    grid.push(row);
  }
  return {
    rows: grid,
    aligns: new Array(c).fill("none") as Align[],
    headerRows: 1,
    cols: c,
    tbodyBreaks: [],
  };
}
