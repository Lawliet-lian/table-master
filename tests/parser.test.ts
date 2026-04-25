import { describe, it, expect } from "vitest";
import { parseTable, splitRow, isSeparatorLine } from "../src/table/parser";
import { serializeExtended, serializeHtml } from "../src/table/serializer";

describe("splitRow", () => {
  it("splits with surrounding pipes", () => {
    expect(splitRow("| a | b | c |")).toEqual(["a", "b", "c"]);
  });
  it("respects escaped pipes", () => {
    expect(splitRow("| a \\| b | c |")).toEqual(["a \\| b", "c"]);
  });
  it("preserves empty tokens created by extra pipes", () => {
    expect(splitRow("| a || c |")).toEqual(["a", "", "c"]);
  });
});

describe("isSeparatorLine", () => {
  it("recognizes basic separators", () => {
    expect(isSeparatorLine("| --- | :---: | ---: |")).toBe(true);
  });
  it("recognizes MultiMarkdown separators", () => {
    expect(isSeparatorLine("| ==== | ---+ |")).toBe(true);
  });
  it("rejects normal rows", () => {
    expect(isSeparatorLine("| a | b |")).toBe(false);
  });
});

describe("parser + serializer round trip (GFM)", () => {
  it("plain table round-trips structurally", () => {
    const src = `| a | b | c |
| --- | --- | --- |
| 1 | 2 | 3 |
| 4 | 5 | 6 |`;
    const { model } = parseTable(src);
    expect(model.cols).toBe(3);
    expect(model.rows.length).toBe(3);
    const out = serializeExtended(model);
    const reparsed = parseTable(out).model;
    expect(reparsed.rows.length).toBe(3);
    expect(reparsed.rows[1][0].raw).toBe("1");
    expect(reparsed.rows[2][2].raw).toBe("6");
  });

  it("preserves alignments", () => {
    const src = `| a | b | c |
| :--- | :---: | ---: |
| 1 | 2 | 3 |`;
    const { model } = parseTable(src);
    expect(model.aligns).toEqual(["left", "center", "right"]);
    const reparsed = parseTable(serializeExtended(model)).model;
    expect(reparsed.aligns).toEqual(["left", "center", "right"]);
  });
});

describe("merged cell parsing (Table Extended syntax)", () => {
  it("parses merge-up `^^`", () => {
    const src = `| h1 | h2 |
| --- | --- |
| a | b |
| ^^ | c |`;
    const { model } = parseTable(src);
    const placeholder = model.rows[2][0];
    expect(placeholder.isAnchor).toBe(false);
    expect(placeholder.anchorRowOffset).toBe(1);
    expect(model.rows[1][0].rowspan).toBe(2);
  });

  it("parses long chains of `^^` with correct anchor span", () => {
    const src = `| A | B |
| --- | --- |
| 1 | 2 |
| ^^ | 3 |
| ^^ | 4 |
| ^^ | 5 |`;
    const { model } = parseTable(src);
    expect(model.rows.length).toBe(5);
    expect(model.rows[1][0].isAnchor).toBe(true);
    expect(model.rows[1][0].rowspan).toBe(4);
    for (let r = 2; r <= 4; r++) {
      expect(model.rows[r][0].isAnchor).toBe(false);
    }
    // Round-trip through serializer must keep the same anchor span.
    const out = serializeExtended(model);
    const re = parseTable(out).model;
    expect(re.rows[1][0].rowspan).toBe(4);
  });

  it("parses colspan from extra pipes", () => {
    const src = `| h1 | h2 | h3 |
| --- | --- | --- |
| a | b ||`;
    const { model } = parseTable(src);
    const placeholder = model.rows[1][2];
    expect(placeholder.isAnchor).toBe(false);
    expect(placeholder.anchorColOffset).toBe(1);
    expect(model.rows[1][1].colspan).toBe(2);
  });

  it("round-trips mixed rowspan and colspan through extended format", () => {
    const src = `| h1 | h2 | h3 |
| --- | --- | --- |
| a | b | c |
| ^^ || d |`;
    const { model } = parseTable(src);
    const out = serializeExtended(model);
    expect(out).toContain("^^ ||");
    const re = parseTable(out).model;
    expect(re.rows[2][0].isAnchor).toBe(false);
    expect(re.rows[2][1].isAnchor).toBe(false);
    expect(re.rows[1][0].rowspan).toBe(2);
    expect(re.rows[1][0].colspan).toBe(2);
  });

  it("emits HTML with correct colspan/rowspan", () => {
    const src = `| h1 | h2 | h3 |
| --- | --- | --- |
| a | b | c |
| ^^ || d |`;
    const { model } = parseTable(src);
    const html = serializeHtml(model);
    expect(html).toContain("rowspan=\"2\"");
    expect(html).toContain("colspan=\"2\"");
  });
});

describe("Table Extended advanced syntax", () => {
  it("parses headerless tables", () => {
    const src = `| --- | --- |
| a | b |`;
    const { model } = parseTable(src);
    expect(model.headerRows).toBe(0);
    expect(serializeHtml(model)).not.toContain("<thead>");
  });

  it("parses captions", () => {
    const src = `[Prototype table]
| a | b |
| --- | --- |
| 1 | 2 |`;
    const { model } = parseTable(src);
    expect(model.caption?.text).toBe("Prototype table");
    expect(serializeExtended(model).startsWith("[Prototype table]")).toBe(true);
    expect(serializeHtml(model)).toContain("<caption>Prototype table</caption>");
  });

  it("parses multiple header rows", () => {
    const src = `| | Grouping ||
| First Header | Second Header | Third Header |
| --- | --- | --- |
| Content | Cell | Cell |`;
    const { model } = parseTable(src);
    expect(model.headerRows).toBe(2);
    expect(model.rows[0][1].colspan).toBe(2);
    expect(serializeHtml(model)).toContain("<thead>");
  });

  it("preserves tbody breaks", () => {
    const src = `| a | b |
| --- | --- |
| 1 | 2 |

| 3 | 4 |`;
    const { model } = parseTable(src);
    expect(model.tbodyBreaks).toEqual([2]);
    expect(serializeExtended(model)).toContain("\n\n| 3 ");
    expect(serializeHtml(model).match(/<tbody>/g)?.length).toBe(2);
  });

  it("parses multiline cells", () => {
    const src = `| a | b |
| --- | --- |
| line 1 | x | \\
| line 2 | y |`;
    const { model } = parseTable(src);
    expect(model.rows[1][0].raw).toBe("line 1\nline 2");
    expect(model.rows[1][1].raw).toBe("x\ny");
    expect(serializeExtended(model)).toContain("\\");
    expect(serializeHtml(model)).toContain("line 1<br>line 2");
  });
});
