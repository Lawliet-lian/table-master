import { describe, it, expect } from "vitest";
import { parseTable } from "../src/table/parser";
import { serializeExtended } from "../src/table/serializer";
import {
  insertRow,
  insertCol,
  deleteRow,
  deleteCol,
  moveRow,
  moveCol,
  setColAlign,
  mergeRange,
  splitCell,
  sortByCol,
} from "../src/table/ops";

const SAMPLE = `| h1 | h2 | h3 |
| --- | --- | --- |
| a | b | c |
| d | e | f |`;

function load(src: string) {
  return parseTable(src).model;
}

describe("ops: insert / delete / move", () => {
  it("inserts a row below", () => {
    const m = insertRow(load(SAMPLE), 1, "below");
    expect(m.rows.length).toBe(4);
    expect(m.rows[2].every((c) => c.raw === "")).toBe(true);
  });

  it("inserts a column to the right", () => {
    const m = insertCol(load(SAMPLE), 1, "right");
    expect(m.cols).toBe(4);
    expect(m.rows[0][2].raw).toBe("");
  });

  it("deletes a body row", () => {
    const m = deleteRow(load(SAMPLE), 1);
    expect(m.rows.length).toBe(2);
    expect(m.rows[1][0].raw).toBe("d");
  });

  it("deletes a column", () => {
    const m = deleteCol(load(SAMPLE), 1);
    expect(m.cols).toBe(2);
    expect(m.rows[0][1].raw).toBe("h3");
  });

  it("moves a row down", () => {
    const m = moveRow(load(SAMPLE), 1, "down");
    expect(m.rows[1][0].raw).toBe("d");
    expect(m.rows[2][0].raw).toBe("a");
  });

  it("moves a column right", () => {
    const m = moveCol(load(SAMPLE), 0, "right");
    expect(m.rows[0][0].raw).toBe("h2");
    expect(m.rows[0][1].raw).toBe("h1");
  });

  it("sets column alignment", () => {
    const m = setColAlign(load(SAMPLE), 1, "center");
    expect(m.aligns[1]).toBe("center");
  });
});

describe("ops: merge / split", () => {
  it("merges a 2x2 region", () => {
    const m = mergeRange(load(SAMPLE), 1, 0, 2, 1);
    expect(m.rows[1][0].isAnchor).toBe(true);
    expect(m.rows[1][0].rowspan).toBe(2);
    expect(m.rows[1][0].colspan).toBe(2);
    expect(m.rows[1][1].isAnchor).toBe(false);
    expect(m.rows[2][0].isAnchor).toBe(false);
  });

  it("splits a merged region back into anchors", () => {
    const merged = mergeRange(load(SAMPLE), 1, 0, 2, 1);
    const split = splitCell(merged, 2, 1);
    expect(split.rows[1][0].rowspan).toBe(1);
    expect(split.rows[1][1].isAnchor).toBe(true);
    expect(split.rows[2][0].isAnchor).toBe(true);
  });

  it("merge then serialize then re-parse keeps merge", () => {
    const merged = mergeRange(load(SAMPLE), 1, 0, 2, 1);
    const out = serializeExtended(merged);
    const reparsed = parseTable(out).model;
    expect(reparsed.rows[1][0].rowspan).toBe(2);
    expect(reparsed.rows[1][0].colspan).toBe(2);
  });

  it("merging downward keeps the anchor at the top cell (^^ on the row below)", () => {
    // Drives the `mergeDown` action: anchor stays at the upper cell, lower cell
    // turns into a `^^` placeholder so the user keeps editing the original
    // text. Equivalent to merge-up but with the cursor on the upper row.
    const merged = mergeRange(load(SAMPLE), 1, 0, 2, 0);
    expect(merged.rows[1][0].isAnchor).toBe(true);
    expect(merged.rows[1][0].rowspan).toBe(2);
    expect(merged.rows[2][0].isAnchor).toBe(false);
    expect(merged.rows[2][0].anchorRowOffset).toBeGreaterThan(0);
    const out = serializeExtended(merged);
    expect(out).toMatch(/\|\s*\^\^\s*\|/);
    const reparsed = parseTable(out).model;
    expect(reparsed.rows[1][0].rowspan).toBe(2);
  });
});

describe("ops: sort", () => {
  it("sorts numerically when possible", () => {
    const src = `| n | x |
| --- | --- |
| 10 | a |
| 2 | b |
| 30 | c |`;
    const r = sortByCol(parseTable(src).model, 0, "asc");
    expect(r.ok).toBe(true);
    expect(r.model.rows[1][0].raw).toBe("2");
    expect(r.model.rows[2][0].raw).toBe("10");
    expect(r.model.rows[3][0].raw).toBe("30");
  });

  it("refuses to sort when body has merges", () => {
    const m = mergeRange(load(SAMPLE), 1, 0, 2, 0);
    const r = sortByCol(m, 0, "asc");
    expect(r.ok).toBe(false);
  });
});
