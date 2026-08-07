import {
  Align,
  Cell,
  TableCaption,
  TableModel,
  makeAnchor,
  makeMergeLeft,
  makeMergeUp,
  recomputeSpans,
  MIN_COL_WIDTH,
} from "./model";

interface RowPart {
  raw: string;
  text: string;
}

interface LogicalRow {
  parts: RowPart[];
  separator: boolean;
  blank: boolean;
}

/** Split a single table line into its raw cell strings, honoring `\|` escapes. */
export function splitRow(line: string): string[] {
  return splitRowParts(line).map((p) => p.text);
}

function splitRowParts(line: string): RowPart[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);

  const cells: RowPart[] = [];
  let buf = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && s[i + 1] === "|") {
      buf += "\\|";
      i++;
      continue;
    }
    if (ch === "|") {
      cells.push({ raw: buf, text: buf.trim() });
      buf = "";
      continue;
    }
    buf += ch;
  }
  cells.push({ raw: buf, text: buf.trim() });
  return cells;
}

/** Detect alignment from a separator cell like `:--`, `:-:`, `--:` or `---`. */
function parseAlign(cell: string): Align | null {
  const s = cell.trim().replace(/\+$/, "");
  if (!/^:?[=\-.]{1,}:?$/.test(s)) return null;
  const left = s.startsWith(":");
  const right = s.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return "none";
}

/** Returns whether the given line looks like a separator row, ignoring pipes. */
export function isSeparatorLine(line: string): boolean {
  const cells = splitRow(line);
  if (!cells.length) return false;
  return cells.every((c) => parseAlign(c) !== null);
}

/** Returns whether the line is a plausible table line (contains `|`). */
export function looksLikeTableLine(line: string): boolean {
  // Must contain at least one unescaped pipe
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\\") {
      escaped = !escaped;
      continue;
    }
    if (line[i] === "|" && !escaped) return true;
    escaped = false;
  }
  return false;
}

export interface ParseResult {
  model: TableModel;
  /** True if the parser had to relax some checks (e.g. ragged rows). */
  warnings: string[];
}

function parseCaption(line: string): TableCaption | null {
  const m = line.trim().match(/^\[([^\]]+)\](?:\s*\[([^\]]+)\])?$/);
  if (!m) return null;
  return { text: m[1], label: m[2] };
}

/**
 * 校验某行是否为 Table Master 的列宽持久化注释。
 * 注释格式固定为：
 *   <!-- tm-colwidths: 120|180|240 -->
 * 允许前后空白。
 */
export function isColWidthsLine(line: string): boolean {
  return /^\s*<!--\s*tm-colwidths\s*:\s*[^\n]*?-->\s*$/.test(line);
}

/**
 * 解析列宽注释为数字数组。
 * 阶段一只接受非负整数像素值，且每项必须 >= MIN_COL_WIDTH。
 * 若任何一项非法或数组为空，则整体视为无效，返回 null。
 */
export function parseColWidths(line: string): number[] | null {
  if (!isColWidthsLine(line)) return null;
  const m = line.trim().match(/^<!--\s*tm-colwidths\s*:\s*([^\n]*?)\s*-->$/);
  if (!m || !m[1]) return null;
  const raw = m[1].trim();
  if (!raw) return null;
  const parts = raw.split("|");
  const out: number[] = [];
  for (const part of parts) {
    const token = part.trim();
    if (!/^\d+$/.test(token)) return null;
    const n = Number(token);
    if (!Number.isFinite(n) || n < MIN_COL_WIDTH) return null;
    out.push(n);
  }
  if (out.length === 0) return null;
  return out;
}

function hasContinuation(line: string): boolean {
  const s = line.trimEnd();
  let count = 0;
  for (let i = s.length - 1; i >= 0 && s[i] === "\\"; i--) count++;
  return count % 2 === 1;
}

function removeContinuation(line: string): string {
  const s = line.trimEnd();
  return s.slice(0, -1);
}

function joinCell(a: string, b: string): string {
  if (a === "") return b;
  if (b === "") return a;
  return `${a}\n${b}`;
}

function logicalRows(lines: string[]): LogicalRow[] {
  const out: LogicalRow[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") {
      out.push({ parts: [], separator: false, blank: true });
      continue;
    }
    let current = hasContinuation(line) ? removeContinuation(line) : line;
    let parts = splitRowParts(current);
    let continued = hasContinuation(line);
    while (continued && i + 1 < lines.length) {
      i++;
      const next = lines[i];
      if (next.trim() === "") break;
      current = hasContinuation(next) ? removeContinuation(next) : next;
      const nextParts = splitRowParts(current);
      const max = Math.max(parts.length, nextParts.length);
      const merged: RowPart[] = [];
      for (let c = 0; c < max; c++) {
        const raw = joinCell(parts[c]?.text ?? "", nextParts[c]?.text ?? "");
        merged.push({ raw, text: raw });
      }
      parts = merged;
      continued = hasContinuation(next);
    }
    out.push({ parts, separator: parts.length > 0 && parts.every((p) => parseAlign(p.text) !== null), blank: false });
  }
  return out;
}

function buildCell(parts: RowPart[], c: number, r: number): Cell {
  const part = parts[c];
  if (!part) return makeAnchor("");
  if (part.text === "^^" && r > 0) return makeMergeUp(1, 0);
  if (part.text === "<" && c > 0) return makeMergeLeft(1, 0);
  if (part.text === "" && part.raw === "" && c > 0) return makeMergeLeft(1, 0);
  return makeAnchor(part.text);
}

/**
 * Parse a contiguous block of table lines. Throws when no valid header/separator
 * pair can be found.
 */
export function parseTable(text: string): ParseResult {
  const rawLines = text.replace(/\r\n?/g, "\n").split("\n");
  while (rawLines.length && rawLines[0].trim() === "") rawLines.shift();
  while (rawLines.length && rawLines[rawLines.length - 1].trim() === "") rawLines.pop();

  if (rawLines.length < 2) throw new Error("Not enough lines for a table");

  // 阶段一只支持“列宽注释紧邻表格上方”的持久化格式，避免下方元数据与 caption 位置组合引入的复杂度。
  // 因此这里先尝试从表头提取 colWidths，并在构建逻辑表前剥离该注释行。
  let colWidths: number[] | undefined;
  if (rawLines.length > 1) {
    const maybe = parseColWidths(rawLines[0]);
    if (maybe) {
      colWidths = maybe;
      rawLines.shift();
    }
  }

  let caption: TableCaption | undefined;
  const firstCaption = parseCaption(rawLines[0]);
  if (firstCaption && rawLines.length > 1) {
    caption = firstCaption;
    rawLines.shift();
  } else {
    const lastCaption = parseCaption(rawLines[rawLines.length - 1]);
    if (lastCaption && rawLines.length > 1) {
      caption = lastCaption;
      rawLines.pop();
    }
  }

  const rows = logicalRows(rawLines);
  const sepEntryIndex = rows.reduce((last, row, idx) => (!row.blank && row.separator ? idx : last), -1);
  if (sepEntryIndex < 0) throw new Error("Missing separator row");

  const nonBlankBeforeSep = rows.slice(0, sepEntryIndex).filter((row) => !row.blank);
  const headerRows = nonBlankBeforeSep.length;
  const sepCells = rows[sepEntryIndex].parts.map((p) => p.text);
  const tableRows = [...nonBlankBeforeSep, ...rows.slice(sepEntryIndex + 1).filter((row) => !row.blank)];
  const cols = Math.max(1, sepCells.length, ...tableRows.map((row) => row.parts.length));

  const aligns: Align[] = [];
  for (let i = 0; i < cols; i++) {
    aligns.push(parseAlign(sepCells[i] ?? "---") ?? "none");
  }

  const warnings: string[] = [];
  const grid: Cell[][] = [];
  const tbodyBreaks: number[] = [];
  let logicalRow = 0;
  let pendingBreak = false;

  for (let i = 0; i < rows.length; i++) {
    const entry = rows[i];
    if (i === sepEntryIndex) continue;
    if (entry.blank) {
      if (i > sepEntryIndex) pendingBreak = true;
      continue;
    }
    if (i > sepEntryIndex && pendingBreak && logicalRow >= headerRows) {
      tbodyBreaks.push(logicalRow);
    }
    pendingBreak = false;
    if (entry.parts.length !== cols) warnings.push(`Row ${logicalRow} has ${entry.parts.length} cells, expected ${cols}`);
    const row: Cell[] = [];
    for (let c = 0; c < cols; c++) {
      row.push(buildCell(entry.parts, c, logicalRow));
    }
    grid.push(row);
    logicalRow++;
  }

  // 列宽数组仅在长度严格等于列数时才生效，否则丢弃，避免后续编辑链路出现越界或错位。
  const normalizedColWidths: number[] | undefined =
    colWidths && colWidths.length === cols ? colWidths : undefined;

  const model: TableModel = {
    rows: grid,
    aligns,
    headerRows,
    cols,
    caption,
    tbodyBreaks,
    colWidths: normalizedColWidths,
  };
  recomputeSpans(model);
  return { model, warnings };
}
