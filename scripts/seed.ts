/**
 * Creates the platform settings document and a starter set of categories. Safe to run more than
 * once: existing categories (matched by slug) and existing settings values are left alone.
 *
 *   npm run seed
 */
import { FieldValue } from "firebase-admin/firestore";
import { db } from "../src/config/firebase.js";
import { DEFAULT_SETTINGS } from "../src/services/settings.service.js";

const CATEGORIES = [
  ["Poetry", "Verse in every form."],
  ["Short Stories", "Complete stories you can finish in one sitting."],
  ["Novels", "Long form fiction, chapter by chapter."],
  ["Essays", "Arguments, reflections and observations."],
  ["Drama", "Plays, scripts and dialogue."],
  ["Memoir", "Life, remembered."],
  ["Creative Nonfiction", "True stories told with craft."],
] as const;

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const settingsRef = db.doc("platform/settings");
if (!(await settingsRef.get()).exists) {
  await settingsRef.set({ ...DEFAULT_SETTINGS, createdAt: FieldValue.serverTimestamp() });
  console.log("Created platform/settings");
}

for (const [name, description] of CATEGORIES) {
  const existing = await db.collection("categories").where("slug", "==", slug(name)).limit(1).get();
  if (!existing.empty) continue;
  await db.collection("categories").add({
    name,
    slug: slug(name),
    description,
    imageUrl: null,
    isActive: true,
    publishedCount: 0,
    createdBy: "seed",
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  console.log(`Created category: ${name}`);
}
console.log("Seed complete.");
process.exit(0);
