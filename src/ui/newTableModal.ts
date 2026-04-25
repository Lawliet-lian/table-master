import { App, Modal, Setting } from "obsidian";
import { t } from "../i18n";

export interface NewTableSpec {
  rows: number;
  cols: number;
  hasHeader: boolean;
}

export class NewTableModal extends Modal {
  private rows = 3;
  private cols = 3;
  private hasHeader = true;
  private readonly buttonLabel: string;
  private readonly onSubmit: (spec: NewTableSpec) => void;

  constructor(app: App, onSubmit: (spec: NewTableSpec) => void, buttonLabel?: string) {
    super(app);
    this.onSubmit = onSubmit;
    this.buttonLabel = buttonLabel ?? t("newTable.insert");
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText(t("newTable.title"));
    contentEl.empty();

    new Setting(contentEl).setName(t("newTable.rows")).addText((tx) => {
      tx.setValue(String(this.rows));
      tx.inputEl.type = "number";
      tx.onChange((v) => {
        const n = parseInt(v, 10);
        if (!isNaN(n) && n > 0) this.rows = n;
      });
    });
    new Setting(contentEl).setName(t("newTable.cols")).addText((tx) => {
      tx.setValue(String(this.cols));
      tx.inputEl.type = "number";
      tx.onChange((v) => {
        const n = parseInt(v, 10);
        if (!isNaN(n) && n > 0) this.cols = n;
      });
    });
    new Setting(contentEl).setName(t("newTable.hasHeader")).addToggle((tg) => {
      tg.setValue(this.hasHeader);
      tg.onChange((v) => {
        this.hasHeader = v;
      });
    });
    new Setting(contentEl).addButton((b) => {
      b.setCta();
      b.setButtonText(this.buttonLabel);
      b.onClick(() => {
        this.onSubmit({
          rows: Math.max(2, this.rows),
          cols: Math.max(1, this.cols),
          hasHeader: this.hasHeader,
        });
        this.close();
      });
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
