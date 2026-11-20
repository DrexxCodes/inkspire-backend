/**
 * Gives an existing Inkspire account a staff role. This is how you create the very first admin.
 *
 *   pnpm make-admin you@example.com              -> super_admin
 *   pnpm make-admin someone@example.com admin    -> admin (or moderator, user)
 *
 * The person must have signed up on the site first (so a profile exists). The change takes
 * effect within about 10 seconds (the backend's profile cache lifetime); a page refresh is enough.
 */
import { FieldValue } from "firebase-admin/firestore";
import { adminAuth, db } from "../src/config/firebase.js";
import { ROLES } from "../src/config/permissions.js";
import type { Role } from "../src/types/domain.js";

const [emailArg, roleArg = "super_admin"] = process.argv.slice(2);
const fail = (msg: string): never => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};

if (!emailArg) fail("Usage: pnpm make-admin <email> [super_admin|admin|moderator|user]");
if (!ROLES.includes(roleArg as Role)) fail(`Unknown role "${roleArg}". Use one of: ${ROLES.join(", ")}`);

const email = emailArg!.trim().toLowerCase();
const user = await adminAuth.getUserByEmail(email).catch(() => null);
if (!user) fail(`No Firebase account with the email ${email}. Sign up on the site first.`);

const ref = db.collection("users").doc(user!.uid);
const snap = await ref.get();
if (!snap.exists) fail(`${email} has a login but no Inkspire profile yet. Open the site and finish the "Finish your profile" step first.`);

const before = snap.get("role") as string;
await ref.update({ role: roleArg, updatedAt: FieldValue.serverTimestamp() });
console.log(`✓ @${snap.get("username")} (${email}): ${before} -> ${roleArg}`);
console.log("  Refresh the site. An \"Admin\" link now appears in the menu, or go to /admin.");
process.exit(0);
