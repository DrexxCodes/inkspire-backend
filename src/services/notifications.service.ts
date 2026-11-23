import { FieldValue } from "firebase-admin/firestore";
import { db } from "../config/firebase.js";

export type NotificationType =
  | "WORK_FLAGGED"
  | "WORK_UNFLAGGED"
  | "WORK_APPROVED"
  | "WORK_REJECTED"
  | "REVIEW_RECEIVED"
  | "NEW_COMMENT"
  | "NEW_LIKE"
  | "BADGE_CONFERRED"
  | "PROMPT_WON";

/** Writes a user facing notification. Failures never block the triggering action. */
export async function notify(
  userId: string,
  n: { type: NotificationType; title: string; body?: string; workId?: string },
  log?: { error: (o: object, m: string) => void },
): Promise<void> {
  try {
    await db
      .collection("users")
      .doc(userId)
      .collection("notifications")
      .add({ ...n, read: false, createdAt: FieldValue.serverTimestamp() });
  } catch (err) {
    log?.error({ userId, type: n.type, err: (err as Error).message }, "NOTIFICATION_WRITE_FAILED");
  }
}
