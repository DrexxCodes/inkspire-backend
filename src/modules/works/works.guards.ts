import type { AuthContext } from "../../types/domain.js";
import { getCategory } from "../../repositories/categories.repo.js";
import { canPostInCategory } from "../../repositories/users.repo.js";
import { canViewWork, getWork, type WorkRecord } from "../../repositories/works.repo.js";
import { badRequest, forbidden, notFound } from "../../utils/errors.js";

/** Loads a work the viewer is allowed to see. Hidden works look exactly like missing ones. */
export async function loadVisibleWork(workId: string, auth?: AuthContext | null): Promise<WorkRecord> {
  const work = await getWork(workId);
  if (!work || !canViewWork(work, auth)) throw notFound("WORK_NOT_FOUND", "That work does not exist or is not available.");
  return work;
}

/** Loads a work the caller authored. Deleted works are treated as missing. */
export async function loadOwnWork(workId: string, auth: AuthContext): Promise<WorkRecord> {
  const work = await getWork(workId);
  if (!work || work.status === "deleted" || work.authorId !== auth.uid) {
    // Same response for "missing" and "not yours" so ids cannot be probed.
    throw notFound("WORK_NOT_FOUND", "That work does not exist or is not available.");
  }
  return work;
}

/** Valid category + the per user posting permission. The backend is the only authority. */
export async function assertPostingAllowed(uid: string, categoryId: string, defaultAllowed: boolean): Promise<void> {
  const category = await getCategory(categoryId);
  if (!category) throw notFound("CATEGORY_NOT_FOUND", "That category does not exist.");
  if (category.isActive === false) throw badRequest("CATEGORY_INACTIVE", "That category is not accepting new works.");
  if (!(await canPostInCategory(uid, categoryId, defaultAllowed))) {
    throw forbidden("CATEGORY_PERMISSION_DENIED", "You are not permitted to publish works in this category.");
  }
}

export const canSeeRevisions = (work: WorkRecord, auth: AuthContext) =>
  work.authorId === auth.uid || auth.permissions.moderateWorks;
