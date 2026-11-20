/**
 * Deploy firestore.rules and firestore.indexes.json to the Firebase project that belongs to
 * the chosen environment.
 *
 *   tsx scripts/deploy-firestore.ts dev          -> project from .env
 *   tsx scripts/deploy-firestore.ts prod         -> project from .env.prod (asks to confirm)
 *   tsx scripts/deploy-firestore.ts prod --yes   -> skip the confirmation (CI)
 *
 * The project id comes from FIREBASE_PROJECT_ID in the env file and is passed to the Firebase
 * CLI with --project, so the deploy target always matches what the server runs against.
 * .firebaserc is not consulted. Only FIREBASE_PROJECT_ID is read from the file, the private
 * key is never loaded here.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { parseEnv } from "node:util";

const ENV_FILES = { dev: ".env", prod: ".env.prod" } as const;
type Target = keyof typeof ENV_FILES;

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith("--")) as Target | undefined;
const skipConfirm = args.includes("--yes");

if (!target || !(target in ENV_FILES)) {
  console.error("Usage: deploy-firestore.ts <dev|prod> [--yes]");
  process.exit(1);
}

const envFile = ENV_FILES[target];
if (!existsSync(envFile)) {
  console.error(`${envFile} not found. Create it from .env.example first.`);
  process.exit(1);
}

const projectId = parseEnv(readFileSync(envFile, "utf8")).FIREBASE_PROJECT_ID?.trim();
if (!projectId || !/^[a-z0-9-]+$/.test(projectId)) {
  console.error(`FIREBASE_PROJECT_ID in ${envFile} is missing or not a valid project id.`);
  process.exit(1);
}

console.log(`Target: ${target}  |  env file: ${envFile}  |  Firebase project: ${projectId}`);

if (target === "prod" && !skipConfirm) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`This deploys rules and indexes to PRODUCTION. Type "${projectId}" to continue: `);
  rl.close();
  if (answer.trim() !== projectId) {
    console.error("Cancelled.");
    process.exit(1);
  }
}

const child = spawn(
  "firebase",
  ["deploy", "--only", "firestore:rules,firestore:indexes", "--project", projectId],
  // The Firebase CLI is firebase.cmd on Windows, which needs a shell. projectId is validated above.
  { stdio: "inherit", shell: process.platform === "win32" },
);
child.on("exit", (code) => process.exit(code ?? 1));
child.on("error", (err) => {
  console.error("Could not run the Firebase CLI. Install it with: npm i -g firebase-tools", err.message);
  process.exit(1);
});
