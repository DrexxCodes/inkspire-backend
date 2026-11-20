import type { ModerationStatus, WorkStatus } from "../../types/domain.js";
import type { StatField } from "../../services/stats.service.js";
import { conflict } from "../../utils/errors.js";

/**
 * Pure moderation state machine. No database access, so every transition and the counter
 * changes that go with it can be tested exhaustively. Services apply the result atomically.
 *
 *   published -> flagged -> (author edits) -> underReview -> approved => published
 *                                                          -> rejected => stays flagged
 */
export interface WorkState {
  status: WorkStatus;
  moderationStatus: ModerationStatus;
  statusBeforeFlag?: WorkStatus | null;
  statusBeforeDelete?: WorkStatus | null;
}

export type Counters = Partial<Record<StatField, number>>;

export interface Transition {
  status: WorkStatus;
  moderationStatus: ModerationStatus;
  counters: Counters;
  /** +1 when the work enters `published`, -1 when it leaves it. */
  publishedDelta: -1 | 0 | 1;
  /** True when nothing needs to change (the request was a repeat). */
  noop: boolean;
  /** True when an open review request must be closed as cancelled. */
  cancelReview: boolean;
}

const same = (s: WorkState): Transition => ({
  status: s.status,
  moderationStatus: s.moderationStatus,
  counters: {},
  publishedDelta: 0,
  noop: true,
  cancelReview: false,
});

/** Status a work returns to when it is unflagged. Never publishes by accident. */
export function statusAfterUnflag(before?: WorkStatus | null): WorkStatus {
  return before && before !== "flagged" && before !== "deleted" ? before : "draft";
}

export function flag(s: WorkState): Transition {
  if (s.status === "deleted") throw conflict("WORK_DELETED", "This work has been deleted.");
  if (s.status === "flagged") return same(s);
  return {
    status: "flagged",
    moderationStatus: "flagged",
    counters: { flaggedWorks: 1 },
    publishedDelta: s.status === "published" ? -1 : 0,
    noop: false,
    cancelReview: false,
  };
}

export function unflag(s: WorkState): Transition {
  if (s.status !== "flagged") throw conflict("NOT_FLAGGED", "This work is not flagged.");
  const back = statusAfterUnflag(s.statusBeforeFlag);
  const underReview = s.moderationStatus === "underReview";
  return {
    status: back,
    moderationStatus: "clean",
    counters: { flaggedWorks: -1, ...(underReview ? { pendingReviews: -1 } : {}) },
    publishedDelta: back === "published" ? 1 : 0,
    noop: false,
    cancelReview: underReview,
  };
}

export function requestReview(s: WorkState): Transition {
  if (s.status !== "flagged") throw conflict("NOT_FLAGGED", "Only flagged works can be sent for review.");
  if (s.moderationStatus === "underReview") return same(s);
  return {
    status: "flagged",
    moderationStatus: "underReview",
    counters: { pendingReviews: 1 },
    publishedDelta: 0,
    noop: false,
    cancelReview: false,
  };
}

function assertUnderReview(s: WorkState) {
  if (s.status !== "flagged" || s.moderationStatus !== "underReview") {
    throw conflict("NOT_UNDER_REVIEW", "This work has no pending review.");
  }
}

export function approve(s: WorkState): Transition {
  assertUnderReview(s);
  return {
    status: "published",
    moderationStatus: "approved",
    counters: { flaggedWorks: -1, pendingReviews: -1, approvedReviews: 1 },
    publishedDelta: 1,
    noop: false,
    cancelReview: false,
  };
}

export function reject(s: WorkState): Transition {
  assertUnderReview(s);
  return {
    status: "flagged",
    moderationStatus: "rejected",
    counters: { pendingReviews: -1, rejectedReviews: 1 },
    publishedDelta: 0,
    noop: false,
    cancelReview: false,
  };
}

/** Soft deletion by an author or a moderator. */
export function softDelete(s: WorkState): Transition {
  if (s.status === "deleted") return same(s);
  const underReview = s.moderationStatus === "underReview";
  return {
    status: "deleted",
    moderationStatus: underReview ? "flagged" : s.moderationStatus,
    counters: {
      totalWorks: -1,
      ...(s.status === "flagged" ? { flaggedWorks: -1 } : {}),
      ...(underReview ? { pendingReviews: -1 } : {}),
    },
    publishedDelta: s.status === "published" ? -1 : 0,
    noop: false,
    cancelReview: underReview,
  };
}

export function restoreDeleted(s: WorkState): Transition {
  if (s.status !== "deleted") throw conflict("NOT_DELETED", "This work is not deleted.");
  const back = s.statusBeforeDelete && s.statusBeforeDelete !== "deleted" ? s.statusBeforeDelete : "draft";
  return {
    status: back,
    moderationStatus: s.moderationStatus,
    counters: { totalWorks: 1, ...(back === "flagged" ? { flaggedWorks: 1 } : {}) },
    publishedDelta: back === "published" ? 1 : 0,
    noop: false,
    cancelReview: false,
  };
}
