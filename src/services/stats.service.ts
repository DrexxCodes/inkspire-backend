import { FieldValue } from "firebase-admin/firestore";
import { db } from "../config/firebase.js";

/**
 * Platform wide counters live in one Firestore document so dashboard summary cards never
 * need to scan collections. Always updated with atomic increments inside the same
 * transaction or batch as the change they describe.
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

export async function readStats(): Promise<Record<StatField, number>> {
  const snap = await statsRef().get();
  const data = snap.data() ?? {};
  const get = (k: StatField) => Math.max(0, Number(data[k] ?? 0));
  return {
    totalUsers: get("totalUsers"),
    totalWorks: get("totalWorks"),
    publishedWorks: get("publishedWorks"),
    flaggedWorks: get("flaggedWorks"),
    pendingReviews: get("pendingReviews"),
    approvedReviews: get("approvedReviews"),
    rejectedReviews: get("rejectedReviews"),
  };
}

/**
 * Adjusts every counter that depends on a work entering or leaving the `published` state:
 * the platform total, the category counter and the author's public work count.
 */
/** Anything with a Firestore `set`, so it works inside both transactions and write batches. */
export interface Writer {
  set: (
    ref: FirebaseFirestore.DocumentReference,
    data: FirebaseFirestore.DocumentData,
    options: FirebaseFirestore.SetOptions,
  ) => unknown;
}

export function applyPublishedDelta(
  tx: Writer,
  work: { categoryId: string; authorId: string },
  delta: 1 | -1,
) {
  tx.set(statsRef(), statsIncrement({ publishedWorks: delta }), { merge: true });
  tx.set(
    db.collection("categories").doc(work.categoryId),
    { publishedCount: FieldValue.increment(delta) },
    { merge: true },
  );
  tx.set(
    db.collection("users").doc(work.authorId),
    { publishedWorkCount: FieldValue.increment(delta) },
    { merge: true },
  );
}
