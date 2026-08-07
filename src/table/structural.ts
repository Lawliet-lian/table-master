// 统一的“表格结构行”判定工具。
//
// 方案文档“风险 1：结构行识别分叉”明确要求：
//   tableLocator / postProcessor / livePreview / actions 四个模块
//   必须共用同一套 caption / colWidths / 结构行判定，避免各自写
//   正则导致后续漂移。本文件就是这套公共判定的唯一定义。

import { isSeparatorLine, looksLikeTableLine, isColWidthsLine } from "./parser";

export { isColWidthsLine } from "./parser";

/**
 * 判断一行是否是表格邻近的 caption 元数据行，格式：
 *   [标题文本]        // 无标签
 *   [标题文本][label] // 带锚点标签
 * 允许前后空白。
 */
export function isCaptionLine(line: string): boolean {
  return /^\s*\[[^\]]+\](?:\s*\[[^\]]+\])?\s*$/.test(line);
}

/**
 * 判断一行是否属于“表格正文行 / 分隔行”，即 Obsidian GFM 原生能
 * 识别为表格块一部分的行。不包含元数据行。
 */
export function isTableContextLine(line: string): boolean {
  return looksLikeTableLine(line) || isSeparatorLine(line);
}

/**
 * 判断一行是否是 Table Master 认可的“表格结构行”：
 * 即可以作为表格块的一部分出现在 separator 两侧的元数据或正文行。
 * 包括：
 *   - 正文行 / 分隔行
 *   - caption 元数据行 [xxx] / [xxx][yyy]
 *   - 列宽持久化注释行 <!-- tm-colwidths: ... -->
 */
export function isStructuralTableLine(line: string): boolean {
  return isTableContextLine(line) || isCaptionLine(line) || isColWidthsLine(line);
}
