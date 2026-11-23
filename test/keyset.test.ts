import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeKey, encodeKey, keysetClause, sliceKeyset } from "../src/utils/pagination.js";

test("a cursor round trips and is validated against the expected key types", () => {
  const c = encodeKey([new Date("2026-01-01T00:00:00.123Z"), "abc"]);
  const back = decodeKey(c, ["ts", "text"])!;
  assert.equal(back[1], "abc");
  assert.equal(new Date(back[0] as string).toISOString(), "2026-01-01T00:00:00.123Z");
});

test("no cursor means the first page", () => {
  assert.equal(decodeKey(undefined, ["int"]), undefined);
  assert.equal(keysetClause(["a"], ["int"], "desc", undefined, []), "");
});

test("junk or wrong shaped cursors are rejected", () => {
  assert.throws(() => decodeKey("not-a-cursor", ["int"]));
  assert.throws(() => decodeKey(encodeKey(["x"]), ["int"]));
  assert.throws(() => decodeKey(encodeKey([1, 2]), ["int"]));
});

test("the clause compares the whole key as a row, with typed placeholders", () => {
  const params: unknown[] = ["w1"];
  const sql = keysetClause(["w.like_count", "w.id"], ["int", "text"], "desc", [5, "x"], params);
  assert.match(sql, /^\(w\.like_count, w\.id\) < \(\$2::\w+, \$3::\w+\)$/);
  assert.deepEqual(params, ["w1", 5, "x"]);
});

test("slicing keeps one page and builds the next cursor only when there is more", () => {
  const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const more = sliceKeyset(rows, 2, (r) => [r.id]);
  assert.equal(more.rows.length, 2);
  assert.deepEqual(decodeKey(more.nextCursor!, ["text"]), ["b"]);
  const last = sliceKeyset(rows.slice(0, 2), 2, (r) => [r.id]);
  assert.equal(last.nextCursor, null);
});
