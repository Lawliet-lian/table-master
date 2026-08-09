import { DEFAULT_COL_WIDTH, MIN_COL_WIDTH } from "./model";
import { parseColWidths } from "./parser";

/**
 * 从一段完整表格源码中提取“表格上方第一条列宽注释”。
 *
 * 这里复用 parser 里已经稳定的 `parseColWidths()` 规则，保证：
 * - 列宽注释格式的合法性只有一套判断标准；
 * - LP 自动回写、普通解析、后续测试三条链路不会各自漂移。
 *
 * 之所以只看首个非空行，是因为当前持久化规范就约定：
 * `tm-colwidths` 只能出现在表格上方的 leading metadata 区域。
 */
export function extractLeadingColWidths(text: string): number[] | null {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length && lines[0].trim() === "") lines.shift();
  if (!lines.length) return null;
  return parseColWidths(lines[0]);
}

/**
 * 把列宽数组强制归一化到当前列数。
 *
 * 这个工具专门服务“表结构已经变了，但源码里的旧 tm-colwidths 还停留在旧列数”
 * 的场景：
 * - 多出来的旧宽度裁掉；
 * - 不够的宽度补默认值；
 * - 所有值统一 round + clamp，避免后续序列化和渲染各自兜底。
 */
export function normalizeColWidthsToCols(widths: readonly number[], cols: number): number[] {
  const normalized = widths.slice(0, Math.max(0, cols));
  while (normalized.length < cols) normalized.push(DEFAULT_COL_WIDTH);
  return normalized.map((raw) => {
    const num = Number.isFinite(raw) ? Math.round(raw) : DEFAULT_COL_WIDTH;
    return Math.max(MIN_COL_WIDTH, num);
  });
}

/**
 * 组合工具：直接从源码里拿到“与当前列数对齐后”的列宽数组。
 *
 * 返回 null 表示源码里根本没有合法的列宽注释；调用方应保留“不自动制造新注释”
 * 的语义。只有当用户原本已经有 `tm-colwidths`，但列数落后时，我们才会拿这个
 * 结果去做补齐回写。
 */
export function deriveNormalizedLeadingColWidths(text: string, cols: number): number[] | null {
  const declared = extractLeadingColWidths(text);
  if (!declared) return null;
  return normalizeColWidthsToCols(declared, cols);
}
