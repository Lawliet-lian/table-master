// Tab / Shift-Tab / Enter navigation between table cells. Used by the editor
// extension wired up in main.ts.

import type { Editor } from "obsidian";
import { locateTable } from "./tableLocator";
import { isSeparatorLine, parseTable } from "../table/parser";
import { serializeExtended } from "../table/serializer";
import { insertRow } from "../table/ops";

function isCaptionLine(line: string): boolean {
  return /^\s*\[[^\]]+\](?:\s*\[[^\]]+\])?\s*$/.test(line);
}

/** Move cursor to the (row, col) cell in the rebuilt table text. */
function placeCursorAt(editor: Editor, startLine: number, lines: string[], row: number, col: number): void {
  let logical = -1;
  let lineIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const candidate = lines[i];
    if (isSeparatorLine(candidate)) continue;
    if (candidate.trim() === "") continue;
    if (isCaptionLine(candidate)) continue;
    logical++;
    if (logical === row) {
      lineIdx = i;
      break;
    }
  }
  if (lineIdx < 0) return;
  const line = lines[lineIdx];
  // Walk column delimiters to compute char position
  let pipes = 0;
  let pos = 0;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "\\") {
      escaped = !escaped;
      pos = i + 1;
      continue;
    }
    if (c === "|" && !escaped) {
      pipes++;
      if (pipes === col + 1) {
        // After the (col+1)-th pipe lies the (col)-th cell content. We want to
        // land just after the leading space.
        pos = i + 1;
        // Skip leading whitespace inside cell
        while (pos < line.length && line[pos] === " ") pos++;
        break;
      }
    }
    escaped = false;
  }
  editor.setCursor({ line: startLine + lineIdx, ch: pos });
}

export function navigateCell(editor: Editor, dir: "next" | "prev"): boolean {
  const loc = locateTable(editor);
  if (!loc) return false;
  const parsed = parseTable(loc.text);
  let model = parsed.model;
  let { row, col } = loc;
  if (row < 0) row = 0;

  if (dir === "next") {
    col += 1;
    if (col >= model.cols) {
      col = 0;
      row += 1;
      if (row >= model.rows.length) {
        // Append a new row at the end
        model = insertRow(model, model.rows.length - 1, "below");
      }
    }
  } else {
    col -= 1;
    if (col < 0) {
      col = model.cols - 1;
      row -= 1;
      if (row < 0) return false;
    }
  }

  const newText = serializeExtended(model);
  editor.replaceRange(
    newText,
    { line: loc.startLine, ch: 0 },
    { line: loc.endLine, ch: editor.getLine(loc.endLine).length },
  );
  const newLines = newText.split("\n");
  placeCursorAt(editor, loc.startLine, newLines, row, col);
  return true;
}

export function navigateRowEnter(editor: Editor): boolean {
  const loc = locateTable(editor);
  if (!loc) return false;
  const parsed = parseTable(loc.text);
  let model = parsed.model;
  let { row, col } = loc;
  if (row < 0) row = 0;
  row += 1;
  if (row >= model.rows.length) {
    model = insertRow(model, model.rows.length - 1, "below");
  }
  const newText = serializeExtended(model);
  editor.replaceRange(
    newText,
    { line: loc.startLine, ch: 0 },
    { line: loc.endLine, ch: editor.getLine(loc.endLine).length },
  );
  const newLines = newText.split("\n");
  placeCursorAt(editor, loc.startLine, newLines, row, col);
  return true;
}
