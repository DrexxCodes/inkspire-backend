import { query } from "../config/postgres.js";
import { withRetry } from "../utils/retry.js";

export type ModerationAction =
  | "FLAG"
  | "UNFLAG"
  | "APPROVE"
  | "REJECT"
  | "DELETE"
  | "RESTORE"
  | "REQUEST_REVIEW";

export type AdminAction =
  | "USER_BLOCKED"
  | "USER_UNBLOCKED"
  | "USER_DISABLED"
  | "USER_REACTIVATED"
  | "USER_ROLE_CHANGED"
  | "USER_PERMISSION_CHANGED"
  | "USER_CATEGORY_PERMISSION_CHANGED"
  | "USER_PASSWORD_RESET_TRIGGERED"
  | "CATEGORY_CREATED"
  | "CATEGORY_UPDATED"
  | "CATEGORY_DELETED"
  | "WORK_FLAGGED"
  | "WORK_UNFLAGGED"
  | "WORK_APPROVED"
  | "WORK_REJECTED"
  | "WORK_DELETED"
  | "WORK_RESTORED"
  | "WORK_PERMANENTLY_DELETED"
  | "PLATFORM_SETTING_CHANGED";

export interface ModerationEntry {
  workId: string;
  userId: string; // the work's author
  moderatorId: string; // the acting user
  actorRole: string;
  action: ModerationAction;
  reason: string | null;
  revisionId?: string | null;
}

export interface AdminEntry {
  adminId: string;
  action: AdminAction;
  targetType: "user" | "work" | "category" | "settings";
  targetId: string;
  metadata?: Record<string, unknown>;
}

/**
 * Audit rows are written after the Firestore change has committed, with retries. If the
 * database is unreachable the full entry is logged at error level so it can be replayed,
 * and the caller is told so the action is never silently unaccounted for.
 */
export async function logModeration(entry: ModerationEntry, log: { error: (o: object, m: string) => void }) {
  try {
    await withRetry(() =>
      query(
        `INSERT INTO moderation_actions (work_id, user_id, moderator_id, actor_role, action, reason, revision_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [entry.workId, entry.userId, entry.moderatorId, entry.actorRole, entry.action, entry.reason, entry.revisionId ?? null],
      ),
    );
  } catch (err) {
    log.error({ auditEntry: entry, err: (err as Error).message }, "AUDIT_WRITE_FAILED moderation_actions");
  }
}

export async function logAdmin(entry: AdminEntry, log: { error: (o: object, m: string) => void }) {
  try {
    await withRetry(() =>
      query(
        `INSERT INTO admin_audit_logs (admin_id, action, target_type, target_id, metadata)
         VALUES ($1,$2,$3,$4,$5::jsonb)`,
        [entry.adminId, entry.action, entry.targetType, entry.targetId, JSON.stringify(entry.metadata ?? {})],
      ),
    );
  } catch (err) {
    log.error({ auditEntry: entry, err: (err as Error).message }, "AUDIT_WRITE_FAILED admin_audit_logs");
  }
}
