import { test } from "node:test";
import assert from "node:assert/strict";
import { acceptsEntries, assertAcceptsEntries, canPickWinners, isPublic, promptPhase } from "../src/modules/prompts/prompts.rules.js";
import { AppError } from "../src/utils/errors.js";

const day = 86_400_000;
const now = new Date("2026-11-23T12:00:00Z");
const timing = (over: object = {}) => ({
  status: "published" as const,
  startsAt: new Date(now.getTime() - day),
  endsAt: new Date(now.getTime() + 6 * day),
  winnersAnnouncedAt: null,
  ...over,
});

test("a draft stays a draft whatever the dates are", () => {
  assert.equal(promptPhase(timing({ status: "draft" }), now), "draft");
  assert.equal(isPublic("draft"), false);
});

test("phases follow the window", () => {
  assert.equal(promptPhase(timing({ startsAt: new Date(now.getTime() + day), endsAt: new Date(now.getTime() + 8 * day) }), now), "upcoming");
  assert.equal(promptPhase(timing(), now), "open");
  assert.equal(promptPhase(timing({ endsAt: new Date(now.getTime() - 1) }), now), "judging");
  assert.equal(promptPhase(timing({ endsAt: new Date(now.getTime() - 1), winnersAnnouncedAt: now }), now), "completed");
});

test("the window is open from the start instant and closed at the end instant", () => {
  assert.equal(promptPhase(timing({ startsAt: now }), now), "open");
  assert.equal(promptPhase(timing({ endsAt: now }), now), "judging");
});

test("only an open prompt accepts entries, and the refusal says why", () => {
  assert.equal(acceptsEntries("open"), true);
  for (const p of ["upcoming", "judging", "completed", "draft"] as const) assert.equal(acceptsEntries(p), false);
  assert.throws(() => assertAcceptsEntries("upcoming"), (e) => e instanceof AppError && e.code === "PROMPT_NOT_STARTED");
  assert.throws(() => assertAcceptsEntries("judging"), (e) => e instanceof AppError && e.code === "PROMPT_CLOSED");
  assert.throws(() => assertAcceptsEntries("completed"), (e) => e instanceof AppError && e.code === "PROMPT_CLOSED");
});

test("winners can be picked once the window ends, and corrected afterwards, never before", () => {
  assert.equal(canPickWinners("judging"), true);
  assert.equal(canPickWinners("completed"), true);
  assert.equal(canPickWinners("open"), false);
  assert.equal(canPickWinners("upcoming"), false);
  assert.equal(canPickWinners("draft"), false);
});
