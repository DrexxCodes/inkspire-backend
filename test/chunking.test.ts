import { test } from "node:test";
import assert from "node:assert/strict";
import { splitIntoChunks, utf8Bytes, assertChunksWithinLimit } from "../src/services/chunking.js";

const check = (text: string, max: number) => {
  const chunks = splitIntoChunks(text, max);
  assert.equal(chunks.join(""), text, "chunks must be lossless");
  for (const c of chunks) assert.ok(utf8Bytes(c) <= max, `chunk of ${utf8Bytes(c)} bytes exceeds ${max}`);
  assertChunksWithinLimit(chunks, max);
  return chunks;
};

test("empty content yields no chunks", () => {
  assert.deepEqual(splitIntoChunks("", 100), []);
});

test("small content stays in one chunk", () => {
  assert.deepEqual(splitIntoChunks("hello world", 100), ["hello world"]);
});

test("prefers paragraph boundaries", () => {
  const p1 = "A".repeat(40) + ".";
  const p2 = "B".repeat(40) + ".";
  const chunks = check(`${p1}\n\n${p2}`, 60);
  assert.equal(chunks.length, 2);
  assert.ok(chunks[0]!.endsWith("\n\n"));
});

test("prefers sentence then word boundaries over mid-word cuts", () => {
  const text = "The quick brown fox jumps over the lazy dog. ".repeat(20);
  const chunks = check(text, 100);
  for (const c of chunks.slice(0, -1)) assert.ok(/\s$/.test(c), "cut should land after whitespace");
  const words = "alpha beta gamma delta epsilon zeta eta theta iota kappa ".repeat(10);
  for (const c of check(words, 37).slice(0, -1)) assert.ok(/\s$/.test(c));
});

test("handles emoji, accents and non-Latin scripts by byte length", () => {
  const text = "Café déjà vu 🌍🔥 你好，世界。 مرحبا بالعالم. ".repeat(60);
  for (const max of [16, 50, 101, 333]) check(text, max);
});

test("never splits a surrogate pair", () => {
  const text = "😀".repeat(200);
  for (const max of [4, 5, 7, 9, 64]) {
    const chunks = check(text, max);
    for (const c of chunks) assert.equal(c, [...c].join(""), "no lone surrogates");
  }
});

test("falls back to a character cut for unbroken text", () => {
  const text = "x".repeat(1000);
  const chunks = check(text, 64);
  assert.equal(chunks.length, Math.ceil(1000 / 64));
});

test("every chunk is under the threshold across random inputs", () => {
  const alphabet = ["a", "b", " ", "\n", "\n\n", ".", "é", "你", "😀", "!", "\r\n"];
  let seed = 42;
  const rand = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  for (let run = 0; run < 60; run++) {
    let text = "";
    const len = Math.floor(rand() * 4000) + 1;
    for (let i = 0; i < len; i++) text += alphabet[Math.floor(rand() * alphabet.length)];
    check(text, 4 + Math.floor(rand() * 400));
  }
});

test("rejects unusable thresholds", () => {
  assert.throws(() => splitIntoChunks("abc", 3), RangeError);
  assert.throws(() => splitIntoChunks("abc", 10.5), RangeError);
});

test("realistic threshold with a large multi byte document", () => {
  const text = "Il était une fois… 🌙 ".repeat(150_000);
  const chunks = check(text, 768_000);
  assert.ok(chunks.length > 1);
});
