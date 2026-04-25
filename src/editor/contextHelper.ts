// Tiny helper used by UI modules to obtain the current ActionContext from the
// active Obsidian editor.

import { App, MarkdownView } from "obsidian";
import type TableMasterPlugin from "../main";
import type { ActionContext } from "./actions";

export function getActionContext(app: App, plugin: TableMasterPlugin): ActionContext | null {
  const view = app.workspace.getActiveViewOfType(MarkdownView);
  if (!view) return null;
  return {
    editor: view.editor,
    format: plugin.settings.outputFormat,
  };
}
