// Right-click context menu inside the editor. Activates only when the cursor
// is sitting inside a recognized table.

import { Editor, MarkdownView, Menu } from "obsidian";
import type TableMasterPlugin from "../main";
import { locateTable } from "../editor/tableLocator";
import * as actions from "../editor/actions";
import { t } from "../i18n";

export function registerContextMenu(plugin: TableMasterPlugin): void {
  plugin.registerEvent(
    plugin.app.workspace.on("editor-menu", (menu: Menu, editor: Editor, view: MarkdownView) => {
      const loc = locateTable(editor);
      if (!loc) return;
      void view;

      const ctx: actions.ActionContext = {
        editor,
        format: plugin.settings.outputFormat,
      };

      menu.addSeparator();

      menu.addItem((i) => i.setTitle(t("cmd.insertRowAbove")).setIcon("arrow-up").onClick(() => actions.insertRowAbove(ctx)));
      menu.addItem((i) => i.setTitle(t("cmd.insertRowBelow")).setIcon("arrow-down").onClick(() => actions.insertRowBelow(ctx)));
      menu.addItem((i) => i.setTitle(t("cmd.insertColLeft")).setIcon("arrow-left").onClick(() => actions.insertColLeft(ctx)));
      menu.addItem((i) => i.setTitle(t("cmd.insertColRight")).setIcon("arrow-right").onClick(() => actions.insertColRight(ctx)));
      menu.addItem((i) => i.setTitle(t("cmd.deleteRow")).setIcon("trash").onClick(() => actions.deleteRow(ctx)));
      menu.addItem((i) => i.setTitle(t("cmd.deleteCol")).setIcon("trash-2").onClick(() => actions.deleteCol(ctx)));

      menu.addSeparator();

      menu.addItem((i) => i.setTitle(t("cmd.mergeUp")).setIcon("chevrons-up").onClick(() => actions.mergeUp(ctx)));
      menu.addItem((i) => i.setTitle(t("cmd.mergeDown")).setIcon("chevrons-down").onClick(() => actions.mergeDown(ctx)));
      menu.addItem((i) => i.setTitle(t("cmd.mergeLeft")).setIcon("chevrons-left").onClick(() => actions.mergeLeft(ctx)));
      menu.addItem((i) => i.setTitle(t("cmd.splitCell")).setIcon("scissors").onClick(() => actions.splitCell(ctx)));

      menu.addSeparator();

      menu.addItem((i) =>
        i
          .setTitle(t("cmd.alignLeft"))
          .setIcon("align-left")
          .onClick(() => actions.alignColumn(ctx, "left")),
      );
      menu.addItem((i) =>
        i
          .setTitle(t("cmd.alignCenter"))
          .setIcon("align-center")
          .onClick(() => actions.alignColumn(ctx, "center")),
      );
      menu.addItem((i) =>
        i
          .setTitle(t("cmd.alignRight"))
          .setIcon("align-right")
          .onClick(() => actions.alignColumn(ctx, "right")),
      );

      menu.addSeparator();
      menu.addItem((i) => i.setTitle(t("cmd.openGridEditor")).setIcon("grid").onClick(() => plugin.openGridEditor()));
      menu.addItem((i) => i.setTitle(t("cmd.formatTable")).setIcon("text").onClick(() => actions.formatTable(ctx)));
    }),
  );
}
