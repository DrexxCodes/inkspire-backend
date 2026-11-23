import {
  FieldPath,
  Timestamp,
  type Query,
  type QueryDocumentSnapshot,
} from "firebase-admin/firestore";
import { badRequest } from "./errors.js";

export function clampLimit(raw: unknown, fallback = 20, max = 50): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), max);
}

function toJson(value: unknown): unknown {
  if (value instanceof Timestamp) return { $ts: [value.seconds, value.nanoseconds] };
  return value ?? null;
}

function fromJson(value: unknown): unknown {
  if (value && typeof value === "object" && "$ts" in value) {
    const [seconds, nanos] = (value as { $ts: [number, number] }).$ts;
    return new Timestamp(seconds, nanos);
  }
  return value;
}

export function encodeCursor(values: unknown[]): string {
  return Buffer.from(JSON.stringify(values.map(toJson))).toString("base64url");
}

export function decodeCursor(cursor?: string | null): unknown[] | undefined {
  if (!cursor) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length > 4) throw new Error("bad cursor");
    return parsed.map(fromJson);
  } catch {
    throw badRequest("INVALID_CURSOR", "The pagination cursor is invalid.");
  }
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * Runs a cursor-paginated Firestore query. The query must already order by the same
 * fields (in the same order) that `cursorFields` returns, ending with the document id.
 */
export async function runPage(
  query: Query,
  opts: {
    limit: number;
    cursor?: string | null;
    cursorFields: (doc: QueryDocumentSnapshot) => unknown[];
  },
): Promise<{ docs: QueryDocumentSnapshot[]; nextCursor: string | null }> {
  let q = query;
  const values = decodeCursor(opts.cursor);
  if (values) q = q.startAfter(...values);
  const snap = await q.limit(opts.limit + 1).get();
  const docs = snap.docs.slice(0, opts.limit);
  const hasMore = snap.docs.length > opts.limit;
  const last = docs[docs.length - 1];
  return { docs, nextCursor: hasMore && last ? encodeCursor(opts.cursorFields(last)) : null };
}

export const docId = () => FieldPath.documentId();

/* ------------------------------------------------------------------------------------------
 * Keyset pagination for PostgreSQL lists (works, comments, prompts, review queue).
 *
 * The cursor is an opaque base64url JSON array of the sort values of the last row, ending with
 * the row id. Timestamps travel as ISO strings and are compared with a typed cast, so a tampered
 * cursor is rejected here instead of reaching the database.
 * ---------------------------------------------------------------------------------------- */

export type KeyType = "ts" | "int" | "text";
const CAST: Record<KeyType, string> = { ts: "timestamptz", int: "bigint", text: "text" };

export function encodeKey(values: unknown[]): string {
  return Buffer.from(JSON.stringify(values.map((v) => (v instanceof Date ? v.toISOString() : v)))).toString("base64url");
}

export function decodeKey(cursor: string | null | undefined, types: KeyType[]): unknown[] | undefined {
  if (!cursor) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== types.length) throw new Error("bad cursor");
    parsed.forEach((v, i) => {
      const type = types[i]!;
      if (type === "int" && !(typeof v === "number" && Number.isSafeInteger(v))) throw new Error("bad int");
      if (type === "text" && !(typeof v === "string" && v.length <= 300)) throw new Error("bad text");
      if (type === "ts" && !(typeof v === "string" && v.length <= 40 && !Number.isNaN(Date.parse(v)))) throw new Error("bad ts");
    });
    return parsed;
  } catch {
    throw badRequest("INVALID_CURSOR", "The pagination cursor is invalid.");
  }
}

/**
 * Builds `(a, b) < ($n::type, $m::type)` for the page after `values`, and pushes the parameters.
 * Every column must sort in the same direction. Returns "" for the first page.
 */
export function keysetClause(
  exprs: string[],
  types: KeyType[],
  dir: "asc" | "desc",
  values: unknown[] | undefined,
  params: unknown[],
): string {
  if (!values) return "";
  const placeholders = values.map((v, i) => {
    params.push(v);
    return `$${params.length}::${CAST[types[i]!]}`;
  });
  return `(${exprs.join(", ")}) ${dir === "desc" ? "<" : ">"} (${placeholders.join(", ")})`;
}

/** Fetch `limit + 1` rows, then this trims the extra one and builds the next cursor from the last kept row. */
export function sliceKeyset<T>(rows: T[], limit: number, key: (row: T) => unknown[]): { rows: T[]; nextCursor: string | null } {
  const kept = rows.slice(0, limit);
  const last = kept[kept.length - 1];
  return { rows: kept, nextCursor: rows.length > limit && last ? encodeKey(key(last)) : null };
}
