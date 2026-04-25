import { describe, it, expect } from "vitest";
import { findTableBlock } from "../src/editor/tableLocator";

function fromText(text: string) {
  const lines = text.split("\n");
  return {
    lines,
    getLine: (n: number) => (n >= 0 && n < lines.length ? lines[n] : null),
    lineCount: lines.length,
  };
}

describe("findTableBlock", () => {
  it("does not merge two tables separated by a single blank line", () => {
    const { getLine, lineCount } = fromText(
      [
        "| a | b |",
        "| - | - |",
        "| 1 | 2 |",
        "",
        "| x | y |",
        "| - | - |",
        "| 3 | 4 |",
      ].join("\n"),
    );
    // Cursor on the second body row of the second table.
    const result = findTableBlock(getLine, lineCount, 6);
    expect(result).toEqual({ startLine: 4, endLine: 6, sepLine: 5 });
  });

  it("anchors on the closer separator when the cursor sits between two tables", () => {
    const { getLine, lineCount } = fromText(
      [
        "| a | b |",
        "| - | - |",
        "| 1 | 2 |",
        "",
        "| x | y |",
        "| - | - |",
        "| 3 | 4 |",
      ].join("\n"),
    );
    // Cursor on Table 1 last body row.
    const result = findTableBlock(getLine, lineCount, 2);
    expect(result).toEqual({ startLine: 0, endLine: 2, sepLine: 1 });
  });

  it("keeps a single blank line as tbody break inside one table", () => {
    const { getLine, lineCount } = fromText(
      [
        "| h | h |",
        "| - | - |",
        "| 1 | 2 |",
        "",
        "| 3 | 4 |",
      ].join("\n"),
    );
    const result = findTableBlock(getLine, lineCount, 4);
    expect(result).toEqual({ startLine: 0, endLine: 4, sepLine: 1 });
  });

  it("includes a leading caption", () => {
    const { getLine, lineCount } = fromText(
      [
        "[Caption]",
        "| a | b |",
        "| - | - |",
        "| 1 | 2 |",
      ].join("\n"),
    );
    const result = findTableBlock(getLine, lineCount, 0);
    expect(result).toEqual({ startLine: 0, endLine: 3, sepLine: 2 });
  });

  it("supports headerless tables", () => {
    const { getLine, lineCount } = fromText(
      [
        "| - | - |",
        "| 1 | 2 |",
      ].join("\n"),
    );
    const result = findTableBlock(getLine, lineCount, 1);
    expect(result).toEqual({ startLine: 0, endLine: 1, sepLine: 0 });
  });

  it("returns null when the cursor is on a non-table line", () => {
    const { getLine, lineCount } = fromText(
      [
        "Some prose",
        "| a | b |",
        "| - | - |",
        "| 1 | 2 |",
      ].join("\n"),
    );
    expect(findTableBlock(getLine, lineCount, 0)).toBeNull();
  });
});
