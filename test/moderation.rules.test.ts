import { test } from "node:test";
import assert from "node:assert/strict";
import {
  approve,
  flag,
  reject,
  requestReview,
  restoreDeleted,
  softDelete,
  statusAfterUnflag,
  unflag,
  type WorkState,
} from "../src/modules/moderation/moderation.rules.js";
import { AppError } from "../src/utils/errors.js";

const state = (over: Partial<WorkState>): WorkState => ({
  status: "published",
  moderationStatus: "clean",
  ...over,
});

const throwsCode = (fn: () => unknown, code: string) =>
  assert.throws(fn, (e: unknown) => e instanceof AppError && e.code === code);

test("flagging a published work unpublishes it and counts it as flagged", () => {
  const t = flag(state({}));
  assert.equal(t.status, "flagged");
  assert.equal(t.moderationStatus, "flagged");
  assert.equal(t.publishedDelta, -1);
  assert.deepEqual(t.counters, { flaggedWorks: 1 });
});

test("flagging a draft does not touch the published counter", () => {
  const t = flag(state({ status: "draft" }));
  assert.equal(t.publishedDelta, 0);
  assert.deepEqual(t.counters, { flaggedWorks: 1 });
});

test("flagging twice is a no-op (idempotent)", () => {
  const t = flag(state({ status: "flagged", moderationStatus: "flagged" }));
  assert.equal(t.noop, true);
  assert.deepEqual(t.counters, {});
  assert.equal(t.publishedDelta, 0);
});

test("a deleted work cannot be flagged", () => {
  throwsCode(() => flag(state({ status: "deleted" })), "WORK_DELETED");
});

test("unflag restores the previous status and never publishes by accident", () => {
  const t = unflag(state({ status: "flagged", moderationStatus: "flagged", statusBeforeFlag: "published" }));
  assert.equal(t.status, "published");
  assert.equal(t.moderationStatus, "clean");
  assert.equal(t.publishedDelta, 1);
  assert.deepEqual(t.counters, { flaggedWorks: -1 });
  assert.equal(statusAfterUnflag(undefined), "draft");
  assert.equal(statusAfterUnflag("flagged"), "draft");
  assert.equal(statusAfterUnflag("deleted"), "draft");
  assert.equal(statusAfterUnflag("archived"), "archived");
});

test("unflagging a work under review also cancels the pending review", () => {
  const t = unflag(state({ status: "flagged", moderationStatus: "underReview", statusBeforeFlag: "published" }));
  assert.equal(t.cancelReview, true);
  assert.deepEqual(t.counters, { flaggedWorks: -1, pendingReviews: -1 });
});

test("unflag requires a flagged work", () => {
  throwsCode(() => unflag(state({})), "NOT_FLAGGED");
});

test("request review moves flagged and rejected works to underReview", () => {
  for (const moderationStatus of ["flagged", "rejected"] as const) {
    const t = requestReview(state({ status: "flagged", moderationStatus }));
    assert.equal(t.moderationStatus, "underReview");
    assert.deepEqual(t.counters, { pendingReviews: 1 });
  }
});

test("request review is idempotent and only valid for flagged works", () => {
  assert.equal(requestReview(state({ status: "flagged", moderationStatus: "underReview" })).noop, true);
  throwsCode(() => requestReview(state({})), "NOT_FLAGGED");
});

test("approve publishes the work and updates every counter", () => {
  const t = approve(state({ status: "flagged", moderationStatus: "underReview" }));
  assert.equal(t.status, "published");
  assert.equal(t.moderationStatus, "approved");
  assert.equal(t.publishedDelta, 1);
  assert.deepEqual(t.counters, { flaggedWorks: -1, pendingReviews: -1, approvedReviews: 1 });
});

test("reject keeps the work flagged and can be followed by another review request", () => {
  const rejected = reject(state({ status: "flagged", moderationStatus: "underReview" }));
  assert.equal(rejected.status, "flagged");
  assert.equal(rejected.moderationStatus, "rejected");
  assert.equal(rejected.publishedDelta, 0);
  assert.deepEqual(rejected.counters, { pendingReviews: -1, rejectedReviews: 1 });
  const again = requestReview(state({ status: "flagged", moderationStatus: rejected.moderationStatus }));
  assert.equal(again.moderationStatus, "underReview");
});

test("approve and reject need a pending review", () => {
  throwsCode(() => approve(state({ status: "flagged", moderationStatus: "flagged" })), "NOT_UNDER_REVIEW");
  throwsCode(() => reject(state({ status: "published" })), "NOT_UNDER_REVIEW");
});

test("soft deleting a published work removes it from the published and total counters", () => {
  const t = softDelete(state({}));
  assert.equal(t.status, "deleted");
  assert.equal(t.publishedDelta, -1);
  assert.deepEqual(t.counters, { totalWorks: -1 });
});

test("soft deleting a work under review cancels the review and fixes counters", () => {
  const t = softDelete(state({ status: "flagged", moderationStatus: "underReview" }));
  assert.equal(t.cancelReview, true);
  assert.equal(t.moderationStatus, "flagged");
  assert.deepEqual(t.counters, { totalWorks: -1, flaggedWorks: -1, pendingReviews: -1 });
});

test("soft deleting twice is a no-op", () => {
  assert.equal(softDelete(state({ status: "deleted" })).noop, true);
});

test("restore returns the work to its previous status with matching counters", () => {
  const published = restoreDeleted(state({ status: "deleted", statusBeforeDelete: "published" }));
  assert.equal(published.status, "published");
  assert.equal(published.publishedDelta, 1);
  assert.deepEqual(published.counters, { totalWorks: 1 });

  const flagged = restoreDeleted(state({ status: "deleted", statusBeforeDelete: "flagged", moderationStatus: "flagged" }));
  assert.equal(flagged.status, "flagged");
  assert.deepEqual(flagged.counters, { totalWorks: 1, flaggedWorks: 1 });

  assert.equal(restoreDeleted(state({ status: "deleted" })).status, "draft");
  throwsCode(() => restoreDeleted(state({})), "NOT_DELETED");
});

test("delete then restore is counter neutral for every starting status", () => {
  const statuses = ["draft", "published", "archived", "flagged"] as const;
  for (const status of statuses) {
    for (const moderationStatus of ["clean", "flagged", "underReview"] as const) {
      if (status !== "flagged" && moderationStatus !== "clean") continue;
      const start = state({ status, moderationStatus });
      const del = softDelete(start);
      const back = restoreDeleted({
        status: del.status,
        moderationStatus: del.moderationStatus,
        statusBeforeDelete: status,
      });
      const net: Record<string, number> = {};
      for (const c of [del.counters, back.counters]) {
        for (const [k, v] of Object.entries(c)) net[k] = (net[k] ?? 0) + (v ?? 0);
      }
      // A cancelled review is the one intentional difference (pendingReviews is not restored).
      const expected = moderationStatus === "underReview" ? { pendingReviews: -1 } : {};
      const actual = Object.fromEntries(Object.entries(net).filter(([, v]) => v !== 0));
      assert.deepEqual(actual, expected, `${status}/${moderationStatus}`);
      assert.equal(del.publishedDelta + back.publishedDelta, 0);
    }
  }
});
