// @vitest-environment happy-dom

import { describe, it, expect } from "vitest";
import { importHtmlTable } from "../src/table/htmlImporter";
import { importTsvTable } from "../src/table/tsvImporter";

// happy-dom provides DOMParser globally; the importer relies on
// `new DOMParser().parseFromString(...)` so no extra setup is needed.

describe("importHtmlTable", () => {
  it("extracts a simple table out of an HTML fragment", () => {
    const html = `
      <table>
        <thead>
          <tr><th>Name</th><th>Score</th></tr>
        </thead>
        <tbody>
          <tr><td>Alice</td><td>10</td></tr>
          <tr><td>Bob</td><td>7</td></tr>
        </tbody>
      </table>
    `;
    const model = importHtmlTable(html);
    expect(model).not.toBeNull();
    expect(model!.cols).toBe(2);
    expect(model!.rows).toHaveLength(3);
    expect(model!.headerRows).toBe(1);
    expect(model!.rows[0][0].raw).toBe("Name");
    expect(model!.rows[0][1].raw).toBe("Score");
    expect(model!.rows[1][0].raw).toBe("Alice");
    expect(model!.rows[2][1].raw).toBe("7");
  });

  it("strips Excel's StartFragment / EndFragment envelope", () => {
    const html = [
      "Version:1.0",
      "<!--StartFragment-->",
      "<table><tr><td>a</td><td>b</td></tr></table>",
      "<!--EndFragment-->",
      "trailing junk",
    ].join("\n");
    const model = importHtmlTable(html);
    expect(model).not.toBeNull();
    expect(model!.cols).toBe(2);
    expect(model!.rows[0][0].raw).toBe("a");
    expect(model!.rows[0][1].raw).toBe("b");
  });

  it("honors rowspan and colspan attributes", () => {
    const html = `
      <table>
        <tr><td rowspan="2">A</td><td colspan="2">B</td></tr>
        <tr><td>C</td><td>D</td></tr>
      </table>
    `;
    const model = importHtmlTable(html);
    expect(model).not.toBeNull();
    expect(model!.cols).toBe(3);
    expect(model!.rows[0][0].isAnchor).toBe(true);
    expect(model!.rows[0][0].raw).toBe("A");
    expect(model!.rows[0][0].rowspan).toBe(2);
    expect(model!.rows[0][1].isAnchor).toBe(true);
    expect(model!.rows[0][1].colspan).toBe(2);
    // (1,0) is the rowspan placeholder for "A"
    expect(model!.rows[1][0].isAnchor).toBe(false);
    expect(model!.rows[1][1].isAnchor).toBe(true);
    expect(model!.rows[1][1].raw).toBe("C");
    expect(model!.rows[1][2].isAnchor).toBe(true);
    expect(model!.rows[1][2].raw).toBe("D");
  });

  it("escapes pipes in cell text so the markdown round-trips", () => {
    const html = "<table><tr><td>a | b</td></tr></table>";
    const model = importHtmlTable(html);
    expect(model).not.toBeNull();
    expect(model!.rows[0][0].raw).toBe("a \\| b");
  });

  it("returns null when there is no table", () => {
    expect(importHtmlTable("<p>no table here</p>")).toBeNull();
    expect(importHtmlTable("")).toBeNull();
  });

  it("collapses <br>/<p>/<div> into `<br>` so each logical row stays single-line", () => {
    // Real-world example from the user's bug report. We keep `<br>` rather
    // than emitting MultiMarkdown `\` continuation because Obsidian's Live
    // Preview widget doesn't understand `\`-continuation: it would split the
    // logical row across multiple `<tr>`s and break our `applyMergesInPlace`
    // mapping, making merged cells "disappear". `<br>` keeps the source on
    // one physical line so merge rendering stays intact, while the inline
    // markdown renderer turns it into a real line break in Reading view.
    const html = `<table><tr><td>电（kWh）<br>【日抄表】</td></tr></table>`;
    const model = importHtmlTable(html);
    expect(model).not.toBeNull();
    expect(model!.rows[0][0].raw).toBe("电（kWh）<br>【日抄表】");
  });
});

describe("importTsvTable", () => {
  it("parses Excel-style tab-separated rows", () => {
    const tsv = ["Name\tScore", "Alice\t10", "Bob\t7"].join("\n");
    const model = importTsvTable(tsv);
    expect(model).not.toBeNull();
    expect(model!.cols).toBe(2);
    expect(model!.rows).toHaveLength(3);
    expect(model!.rows[0][0].raw).toBe("Name");
    expect(model!.rows[2][1].raw).toBe("7");
  });

  it("honors quoted cells with embedded newlines", () => {
    const tsv = `Name\tBio\nAlice\t"line 1\nline 2"\n`;
    const model = importTsvTable(tsv);
    expect(model).not.toBeNull();
    expect(model!.rows[1][1].raw).toBe("line 1<br>line 2");
  });

  it("escapes pipes inside cell content", () => {
    const tsv = "a\tb | c\n";
    const model = importTsvTable(tsv);
    expect(model).not.toBeNull();
    expect(model!.rows[0][1].raw).toBe("b \\| c");
  });

  it("returns null for prose without tabs", () => {
    expect(importTsvTable("just one paragraph of text")).toBeNull();
    expect(importTsvTable("")).toBeNull();
  });

  it("pads ragged rows so every row has the same column count", () => {
    const tsv = "a\tb\tc\nd\te\n";
    const model = importTsvTable(tsv);
    expect(model).not.toBeNull();
    expect(model!.cols).toBe(3);
    expect(model!.rows[1][2].raw).toBe("");
  });
});
