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
import { isSeparatorLine, looksLikeTableLine, parseTable } from "../table/parser";

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
  const lines = info.text.split(/\r?\n/).slice(info.lineStart, info.lineEnd + 1);
  const blocks: string[] = [];
  let buf: string[] = [];
  let blanks = 0;
  let inTable = false;
  let hasSep = false;

  const flush = () => {
    while (buf.length && buf[buf.length - 1].trim() === "") buf.pop();
    if (buf.length && hasSep) blocks.push(buf.join("\n"));
    buf = [];
    blanks = 0;
    inTable = false;
    hasSep = false;
  };

  for (const line of lines) {
    if (line.trim() === "") {
      if (!inTable) continue;
      blanks++;
      if (blanks >= 2) {
        flush();
      } else {
        buf.push(line);
      }
      continue;
    }
    if (looksLikeTableLine(line) || isSeparatorLine(line) || /^\s*\[[^\]]+\](?:\s*\[[^\]]+\])?\s*$/.test(line)) {
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
      }
      buf.push(line);
      blanks = 0;
      inTable = true;
      if (isSeparatorLine(line)) hasSep = true;
      continue;
    }
    if (inTable) flush();
  }
  if (buf.length) flush();
  return blocks;
}
