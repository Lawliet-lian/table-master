// Reading-view post-processor. We re-parse the original markdown for each
// rendered table (via `MarkdownPostProcessorContext.getSectionInfo`) and rebuild
// the `<table>` so MultiMarkdown features (rowspan / colspan / caption /
// multi-header / multi-tbody / multiline cells) survive the trip through
// Obsidian's GFM renderer.

import {
  App,
  Component,
  MarkdownPostProcessor,
  MarkdownPostProcessorContext,
} from "obsidian";
import { applyModelToTable } from "./tableRenderer";
import { isSeparatorLine, parseTable } from "../table/parser";
import { isCaptionLine, isColWidthsLine, isStructuralTableLine } from "../table/structural";

interface PostProcessorOptions {
  component: Component;
  app: App;
}

export function buildTableMergePostProcessor(opts: PostProcessorOptions): MarkdownPostProcessor {
  return (el, ctx) => {
    const tables = Array.from(el.querySelectorAll<HTMLTableElement>("table"));
    if (!tables.length) return;
    const sources = collectTableSources(el, ctx);
    for (let i = 0; i < tables.length; i++) {
      const table = tables[i];
      const src = sources[i];
      if (!src) continue;
      try {
        const { model } = parseTable(src);
        // Render asynchronously; failures shouldn't break the section.
        void applyModelToTable(table, model, {
          sourcePath: ctx.sourcePath,
          component: opts.component,
          app: opts.app,
          renderInline: true,
        });
      } catch {
        // Leave the original GFM rendering in place if the source can't be
        // parsed as an extended table.
      }
    }
  };
}

/**
 * Recover the markdown source for each table in `el` using the section info
 * Obsidian gives us. We split the section into table blocks (separated by at
 * least two blank lines) so each `<table>` lines up with the right snippet.
 */
function collectTableSources(el: HTMLElement, ctx: MarkdownPostProcessorContext): string[] {
  const info = ctx.getSectionInfo(el);
  if (!info) return [];
  const fullLines = info.text.split(/\r?\n/);
  const start = extendRangeStartForLeadingMetadata(fullLines, info.lineStart);
  const lines = fullLines.slice(start, info.lineEnd + 1);
  const blocks: string[] = [];
  let buf: string[] = [];
  let blanks = 0;
  let inTable = false;
  let hasSep = false;
  // Track whether the last consumed blank line bridges a colWidths/caption line
  // with the header. This lets "colWidths + empty + header" (the form we
  // serialize when there is no caption, required to keep Obsidian LP happy)
  // still be recognised as a single table block without risking gluing two
  // adjacent tables together via ≥2 blanks.
  let allowOneBlank = true;

  const flush = () => {
    while (buf.length && buf[buf.length - 1].trim() === "") buf.pop();
    if (buf.length && hasSep) blocks.push(buf.join("\n"));
    buf = [];
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
      // Keep the existing "double blank = flush to new table" rule so two
      // neighbouring tables are never merged.
      if (blanks >= 2) {
        flush();
      } else if (allowOneBlank && i + 1 < lines.length) {
        // Peek one line ahead: a single blank is only absorbed when the next
        // non-blank line is *still* part of the same structural table (and
        // not another separator — another separator always means a new table
        // per the existing split logic below).
        const next = lines[i + 1];
        if (next != null && isStructuralTableLine(next) && !isSeparatorLine(next)) {
          buf.push(line);
          allowOneBlank = false;
          continue;
        }
        // Otherwise treat the single blank like a break and let the fallback
        // flush at the end of the loop kick in so we don't extend past it.
        flush();
      } else {
        flush();
      }
      continue;
    }
    if (isStructuralTableLine(line)) {
      // A second separator line means a new table is starting — flush the
      // previous one. We also remove any trailing blanks and the header line
      // that was already buffered as part of the new table's header.
      if (isSeparatorLine(line) && hasSep) {
        // The line(s) between the last blank and this separator belong to the
        // new table's header. Pop them off the old buffer and re-add after flush.
        const newHeader: string[] = [];
        while (buf.length && buf[buf.length - 1].trim() !== "" && !isSeparatorLine(buf[buf.length - 1])) {
          newHeader.unshift(buf.pop()!);
        }
        while (buf.length && buf[buf.length - 1].trim() === "") buf.pop();
        flush();
        buf.push(...newHeader);
        allowOneBlank = true;
      }
      buf.push(line);
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

/**
 * Reading view may hand the post-processor a section whose first visible line
 * is already the table header, while the `<!-- tm-colwidths -->` HTML comment
 * just above it lives in the previous rendered block. When that happens the
 * parser never sees `colWidths`, so reading mode falls back to equal-width
 * columns even though the source markdown contains persisted widths.
 *
 * To keep the fix narrowly scoped, we only look upward for *metadata* lines
 * (colWidths / caption) and at most one bridging blank line. We never absorb
 * ordinary table body/header rows or another separator row here, which avoids
 * accidentally gluing the previous table into this section.
 */
function extendRangeStartForLeadingMetadata(lines: string[], start: number): number {
  let out = start;
  let consumedBlank = false;
  while (out > 0) {
    const prev = lines[out - 1];
    if (isColWidthsLine(prev) || isCaptionLine(prev)) {
      out--;
      continue;
    }
    if (prev.trim() === "" && !consumedBlank && out - 1 > 0) {
      const prevPrev = lines[out - 2];
      const next = lines[out];
      // 只吸收“元数据和表头之间”的那一行空白：
      //   <!-- tm-colwidths: ... -->
      //
      //   | header | ... |
      // 不允许把普通正文空白或上一张表的尾部一起吞进来。
      if (
        next != null &&
        isStructuralTableLine(next) &&
        !isSeparatorLine(next) &&
        (isColWidthsLine(prevPrev) || isCaptionLine(prevPrev))
      ) {
        out--;
        consumedBlank = true;
        continue;
      }
    }
    break;
  }
  return out;
}
