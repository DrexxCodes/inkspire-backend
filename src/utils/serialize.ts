import { Timestamp } from "firebase-admin/firestore";

/** Converts Firestore values into JSON friendly values (Timestamps become ISO strings). */
export function serialize<T>(value: T): T {
  if (value instanceof Timestamp) return value.toDate().toISOString() as unknown as T;
  if (Array.isArray(value)) return value.map((v) => serialize(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = serialize(v);
    }
    return out as T;
  }
  return value;
}
