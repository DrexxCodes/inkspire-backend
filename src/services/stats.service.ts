import { FieldValue } from "firebase-admin/firestore";
import { db } from "../config/firebase.js";
import { getPlatformWorkStats } from "../repositories/work-stats.repo.js";

/**
 * Platform wide counters. The user total lives in one Firestore document, updated with atomic
 * increments. Work totals are no longer stored: works live in PostgreSQL, so they are counted there.
 * The work fields stay in StatField because the moderation rules still describe them.
 */
export type StatField =
  | "totalUsers"
  | "totalWorks"
  | "publishedWorks"
  | "flaggedWorks"
  | "pendingReviews"
  | "approvedReviews"
  | "rejectedReviews";

export const statsRef = () => db.doc("platform/stats");

export function statsIncrement(delta: Partial<Record<StatField, number>>) {
  const data: Record<string, FirebaseFirestore.FieldValue> = {};
  for (const [key, value] of Object.entries(delta)) {
    if (value) data[key] = FieldValue.increment(value);
  }
  return data;
}

/** The user total is a Firestore counter. Everything about works is computed from PostgreSQL. */
export async function readStats(): Promise<Record<StatField, number>> {
  const [snap, works] = await Promise.all([statsRef().get(), getPlatformWorkStats()]);
  return {
    totalUsers: Math.max(0, Number((snap.data() ?? {}).totalUsers ?? 0)),
    ...works,
  };
}
