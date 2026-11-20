/**
 * Checks that Firestore is set up the way the backend expects. Run it after deploying:
 *
 *   pnpm check:firestore
 *
 * 1. Compares the project the Firebase CLI deploys to (.firebaserc) with the project the
 *    backend actually talks to (FIREBASE_PROJECT_ID). If they differ, `firebase deploy` can
 *    say "Deploy complete" while your console shows nothing, because it deployed elsewhere.
 * 2. Runs one tiny query per index in firestore.indexes.json against the live database and
 *    reports which ones are missing or still building.
 */
import { readFileSync } from "node:fs";
import { db } from "../src/config/firebase.js";
import { env } from "../src/config/env.js";

interface IndexDef {
  collectionGroup: string;
  fields: { fieldPath: string; order: "ASCENDING" | "DESCENDING" }[];
}

const read = (name: string) => JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), "utf8"));

const cliProject: string | undefined = read(".firebaserc").projects?.default;
const firebaseJson = read("firebase.json");
console.log(`Backend project (FIREBASE_PROJECT_ID): ${env.FIREBASE_PROJECT_ID}`);
console.log(`CLI deploy project (.firebaserc):      ${cliProject}`);
console.log(`Firestore database in firebase.json:   ${firebaseJson.firestore?.database ?? "(default)"}`);
if (cliProject !== env.FIREBASE_PROJECT_ID) {
  console.log("\n✗ MISMATCH. `firebase deploy` is sending rules and indexes to a different project than the one");
  console.log(`  your backend uses. Fix with:  firebase use ${env.FIREBASE_PROJECT_ID}\n`);
} else {
  console.log("✓ Same project.\n");
}

const { indexes } = read("firestore.indexes.json") as { indexes: IndexDef[] };
let missing = 0;
let building = 0;

for (const def of indexes) {
  const label = `${def.collectionGroup} (${def.fields.map((f) => `${f.fieldPath} ${f.order === "ASCENDING" ? "↑" : "↓"}`).join(", ")})`;
  // `comments` lives under works/{id}, so query a collection path, exactly like the backend does.
  const base: FirebaseFirestore.Query =
    def.collectionGroup === "comments" ? db.collection("works/__check__/comments") : db.collection(def.collectionGroup);
  let q = base;
  def.fields.slice(0, -1).forEach((f) => (q = q.where(f.fieldPath, "==", "__check__")));
  const last = def.fields[def.fields.length - 1]!;
  q = q.orderBy(last.fieldPath, last.order === "ASCENDING" ? "asc" : "desc").limit(1);
  try {
    await q.get();
    console.log(`✓ ${label}`);
  } catch (err) {
    const e = err as { code?: number; message?: string };
    if (e.code === 9) {
      const isBuilding = /currently building/i.test(e.message ?? "");
      isBuilding ? building++ : missing++;
      console.log(`${isBuilding ? "…" : "✗"} ${label} ${isBuilding ? "is still building" : "is MISSING"}`);
    } else {
      console.log(`? ${label}: ${e.message}`);
    }
  }
}

console.log(`\n${indexes.length - missing - building}/${indexes.length} ready, ${building} building, ${missing} missing.`);
if (missing) console.log("Deploy them with:  firebase deploy --only firestore:indexes");
process.exit(missing ? 1 : 0);
