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
