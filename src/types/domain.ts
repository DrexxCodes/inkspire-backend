import type { PermissionMap } from "../config/permissions.js";

export type Role = "user" | "moderator" | "admin" | "super_admin";
export type AccountStatus = "active" | "disabled" | "blocked";
export type WorkStatus = "draft" | "published" | "flagged" | "archived" | "deleted";
export type Visibility = "public" | "private";
export type ModerationStatus = "clean" | "flagged" | "underReview" | "approved" | "rejected";

export type Doc = FirebaseFirestore.DocumentData & { id: string };

export interface UserDoc extends Doc {
  username: string;
  usernameLower: string;
  displayName: string;
  bio: string;
  email?: string;
  profilePhotoUrl: string | null;
  coverPhotoUrl: string | null;
  avatarType: "dicebear" | "uploaded";
  role: Role;
  permissions?: Partial<PermissionMap>;
  accountStatus: AccountStatus;
  publishedWorkCount?: number;
  likesReceived?: number;
  /** Verification badge conferred by a super admin. Missing means not verified. */
  verified?: boolean;
  verifiedAt?: FirebaseFirestore.Timestamp | null;
  verifiedBy?: string | null;
}

export interface AuthContext {
  uid: string;
  email: string | null;
  emailVerified: boolean;
  profile: UserDoc;
  permissions: PermissionMap;
}

export type ShareTarget =
  | "copy_link"
  | "whatsapp"
  | "x"
  | "facebook"
  | "telegram"
  | "native_share";

export type MetricName =
  | "signups"
  | "works_created"
  | "works_published"
  | "likes"
  | "comments"
  | "shares"
  | "views";
