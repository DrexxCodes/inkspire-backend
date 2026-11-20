import { test } from "node:test";
import assert from "node:assert/strict";
import { TtlSet } from "../src/utils/ttl-set.js";
import { makeExcerpt, slugify, USERNAME_PATTERN, RESERVED_USERNAMES } from "../src/utils/text.js";
import { chunkId } from "../src/services/chunking.js";
import { withRetry } from "../src/utils/retry.js";
import { AppError, forbidden, notFound } from "../src/utils/errors.js";

test("TtlSet drops duplicates inside the window and accepts them after it expires", () => {
  let now = 1_000;
  const set = new TtlSet(60_000, 100, () => now);
  assert.equal(set.addIfNew("a"), true);
  assert.equal(set.addIfNew("a"), false);
  assert.equal(set.addIfNew("b"), true);
  now += 59_999;
  assert.equal(set.addIfNew("a"), false);
  now += 2;
  assert.equal(set.addIfNew("a"), true);
});

test("TtlSet never grows beyond its bound", () => {
  const set = new TtlSet(60_000, 10, () => 5);
  for (let i = 0; i < 1000; i++) set.addIfNew(`k${i}`);
  assert.ok(set.size <= 10);
});

test("chunk ids sort lexically in chunk order", () => {
  const ids = [0, 1, 2, 9, 10, 11, 99, 100, 1000, 12345].map((i) => chunkId("r3_", i));
  assert.deepEqual([...ids].sort(), ids);
  assert.equal(chunkId("", 7), "000007");
});

test("slugify strips accents and symbols", () => {
  assert.equal(slugify("Short Stories & Tales!"), "short-stories-tales");
  assert.equal(slugify("  Café   Poésie "), "cafe-poesie");
  assert.equal(slugify("***"), "");
});

test("excerpt collapses whitespace and cuts on a word boundary", () => {
  const text = "The   quick\n\nbrown fox jumps over the lazy dog. ".repeat(20);
  const ex = makeExcerpt(text, 60);
  assert.ok(ex.length <= 61);
  assert.ok(ex.endsWith("…"));
  assert.ok(!/\s{2,}/.test(ex));
  assert.equal(makeExcerpt("short", 60), "short");
});

test("username rules", () => {
  assert.ok(USERNAME_PATTERN.test("jerry_k"));
  assert.ok(!USERNAME_PATTERN.test("Jerry"));
  assert.ok(!USERNAME_PATTERN.test("ab"));
  assert.ok(!USERNAME_PATTERN.test("has space"));
  assert.ok(!USERNAME_PATTERN.test("x".repeat(25)));
  assert.ok(RESERVED_USERNAMES.has("admin"));
});

test("withRetry retries then succeeds, and rethrows the last error when exhausted", async () => {
  let calls = 0;
  const value = await withRetry(
    async () => {
      calls++;
      if (calls < 3) throw new Error("flaky");
      return "ok";
    },
    3,
    1,
  );
  assert.equal(value, "ok");
  assert.equal(calls, 3);
  await assert.rejects(() => withRetry(async () => { throw new Error("always"); }, 2, 1), /always/);
});

test("structured errors carry code and status", () => {
  const e = forbidden("CATEGORY_PERMISSION_DENIED", "nope");
  assert.ok(e instanceof AppError);
  assert.equal(e.statusCode, 403);
  assert.equal(e.code, "CATEGORY_PERMISSION_DENIED");
  assert.equal(notFound().statusCode, 404);
});
