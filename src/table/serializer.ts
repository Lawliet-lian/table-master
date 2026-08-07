// Serialize a TableModel back to markdown. Two formats are supported:
//   - "extended": GFM table with Table Extended `^^` / `<` placeholders for merged cells
//   - "html":     raw <table> with colspan/rowspan attributes

import { Align, Cell, TableModel, recomputeSpans, MIN_COL_WIDTH } from "./model";

export type OutputFormat = "extended" | "html";

function alignToSep(a: Align, width: number): string {
  const w = Math.max(width, 3);
  switch (a) {
    case "left":
      return ":" + "-".repeat(w - 1);
    case "right":
      return "-".repeat(w - 1) + ":";
    case "center":
      return ":" + "-".repeat(w - 2) + ":";
    default:
      return "-".repeat(w);
  }
}

/** Compute display width for padding (treats CJK chars as width 2). */
function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    // Common CJK ranges
    if (
      (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
      (cp >= 0x2e80 && cp <= 0x303e) ||
      (cp >= 0x3041 && cp <= 0x33ff) ||
      (cp >= 0x3400 && cp <= 0x4dbf) ||
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0xa000 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe4f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6)
    ) {
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}

function padCell(s: string, width: number, align: Align): string {
  const dw = displayWidth(s);
  const pad = Math.max(0, width - dw);
  if (align === "right") return " ".repeat(pad) + s;
  if (align === "center") {
    const left = Math.floor(pad / 2);
    return " ".repeat(left) + s + " ".repeat(pad - left);
  }
  return s + " ".repeat(pad);
}

function cellToken(cell: Cell): string {
  if (cell.isAnchor) return cell.raw;
  if (cell.anchorRowOffset > 0) return "^^";
  if (cell.anchorColOffset > 0) return "<";
  return cell.raw;
}

function isColspanPlaceholder(cell: Cell): boolean {
  return !cell.isAnchor && cell.anchorColOffset > 0;
}

function captionLine(model: TableModel): string | null {
  if (!model.caption) return null;
  return model.caption.label ? `[${model.caption.text}][${model.caption.label}]` : `[${model.caption.text}]`;
}

/**
 * 生成列宽持久化注释行。
 * 输出严格前置校验：数组存在、长度等于列数、每一项都是合法整数且 >= MIN_COL_WIDTH。
 * 任何一项不满足都不输出注释，避免写出下游 parser 会判定为非法的元数据。
 */
function colWidthsLine(model: TableModel): string | null {
  if (!model.colWidths) return null;
  if (model.colWidths.length !== model.cols) return null;
  for (const w of model.colWidths) {
    if (!Number.isFinite(w) || w < MIN_COL_WIDTH || !Number.isInteger(w)) return null;
  }
  return `<!-- tm-colwidths: ${model.colWidths.join("|")} -->`;
}

function splitCellLines(cell: Cell): string[] {
  if (isColspanPlaceholder(cell)) return ["<"];
  return cellToken(cell).split("\n");
}

export function serializeExtended(model: TableModel): string {
  recomputeSpans(model);
  const cols = model.cols;
  const widths = Array.from({ length: cols }, (): number => 3);
  for (const row of model.rows) {
    for (let c = 0; c < cols; c++) {
      const cell = row[c];
      if (isColspanPlaceholder(cell)) continue;
      for (const tok of splitCellLines(cell)) {
        const w = displayWidth(tok);
        if (w + 2 > widths[c]) widths[c] = w + 2;
      }
    }
  }
  for (let c = 0; c < cols; c++) {
    const a = model.aligns[c];
    const minSep = a === "center" ? 5 : a === "left" || a === "right" ? 4 : 3;
    if (widths[c] < minSep) widths[c] = minSep;
  }

  const lines: string[] = [];
  // 固定输出顺序：列宽注释 -> caption -> 表格主体，保证序列化稳定，也与 parseTable 的解析顺序一致。
  const cw = colWidthsLine(model);
  const cap = captionLine(model);
  if (cw) {
    lines.push(cw);
    // Obsidian Live Preview / 源码视图下，HTML 块注释若与下一行 GFM 表头紧挨着会被一并纳入
    // paragraph 块，导致表格无法被渲染为 <table>（阅读模式无此问题）。
    // 规避策略：当“有 colWidths 注释且没有 caption（即注释下一行直接是 | 表头行 / separator）”
    // 时，在注释与表头之间插 1 行空行，形成 Obsidian 要求的块边界；若存在 caption，则 caption
    // 本身能充当“结构块边界”，不需要额外空行，保持视觉紧凑。
    if (!cap) lines.push("");
  }
  if (cap) lines.push(cap);

  for (let r = 0; r < model.headerRows; r++) {
    lines.push(...formatRow(model.rows[r], widths, model.aligns));
  }
  const sep = model.aligns
    .map((a, i) => alignToSep(a, widths[i]))
    .map((s) => ` ${s} `.replace(/^\s|\s$/g, ""));
  lines.push("| " + sep.join(" | ") + " |");

  const breaks = new Set(model.tbodyBreaks ?? []);
  for (let r = model.headerRows; r < model.rows.length; r++) {
    if (breaks.has(r)) lines.push("");
    lines.push(...formatRow(model.rows[r], widths, model.aligns));
  }
  return lines.join("\n");
}

function formatRow(row: Cell[], widths: number[], aligns: Align[]): string[] {
  const cellLines = row.map(splitCellLines);
  const physicalRows = Math.max(1, ...cellLines.map((lines) => lines.length));
  const out: string[] = [];
  for (let lineIdx = 0; lineIdx < physicalRows; lineIdx++) {
    let line = "";
    for (let c = 0; c < row.length; c++) {
      const cell = row[c];
      if (isColspanPlaceholder(cell)) {
        const inner = padCell("<", widths[c] - 2, aligns[c] ?? "none");
        line += `| ${inner} `;
        continue;
      }
      const tok = cellLines[c][lineIdx] ?? "";
      const inner = padCell(tok, widths[c] - 2, aligns[c] ?? "none");
      line += `| ${inner} `;
    }
    line += "|";
    if (lineIdx < physicalRows - 1) line += " \\";
    out.push(line);
  }
  return out;
}

export function serializeHtml(model: TableModel): string {
  recomputeSpans(model);
  const lines: string[] = [];
  // 即使选择 HTML 输出，也把列宽注释写在 <table> 之前，保证切换输出格式时元数据不会丢失。
  // HTML 路径下 caption 被内嵌到 <caption> 里，不会像扩展格式那样作为独立行出现在源文件中，
  // 因此这里只要写出了 colWidths 注释，就固定与 <table> 之间空一行，保持 Obsidian 对 HTML
  // 块的块边界判定稳定，避免“HTML 注释紧邻 <table>”时出现的非预期段落拼接。
  const cw = colWidthsLine(model);
  if (cw) {
    lines.push(cw);
    lines.push("");
  }
  lines.push("<table>");
  if (model.caption) lines.push(`<caption>${escapeHtml(model.caption.text)}</caption>`);
  if (model.headerRows > 0) {
    lines.push("<thead>");
    for (let r = 0; r < model.headerRows; r++) lines.push(rowToHtml(model, r, "th"));
    lines.push("</thead>");
  }
  if (model.rows.length > model.headerRows) {
    const breaks = new Set(model.tbodyBreaks ?? []);
    let open = false;
    for (let r = model.headerRows; r < model.rows.length; r++) {
      if (!open || breaks.has(r)) {
        if (open) lines.push("</tbody>");
        lines.push("<tbody>");
        open = true;
      }
      lines.push(rowToHtml(model, r, "td"));
    }
    if (open) lines.push("</tbody>");
  }
  lines.push("</table>");
  return lines.join("\n");
}

function rowToHtml(model: TableModel, r: number, tag: "td" | "th"): string {
  const parts: string[] = ["<tr>"];
  for (let c = 0; c < model.cols; c++) {
    const cell = model.rows[r][c];
    if (!cell.isAnchor) continue;
    const align = model.aligns[c];
    const attrs: string[] = [];
    if (cell.rowspan > 1) attrs.push(`rowspan="${cell.rowspan}"`);
    if (cell.colspan > 1) attrs.push(`colspan="${cell.colspan}"`);
    if (align !== "none") attrs.push(`style="text-align:${align}"`);
    const a = attrs.length ? " " + attrs.join(" ") : "";
    parts.push(`<${tag}${a}>${escapeHtml(cell.raw).replace(/\n/g, "<br>")}</${tag}>`);
  }
  parts.push("</tr>");
  return parts.join("");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Choose serializer by format. */
export function serialize(model: TableModel, fmt: OutputFormat): string {
  return fmt === "html" ? serializeHtml(model) : serializeExtended(model);
}
