import { randomUUID } from "node:crypto";

/** 32 hex characters. Same shape as the inkspire_id() default in PostgreSQL, so ids are interchangeable. */
export const newId = (): string => randomUUID().replace(/-/g, "");

/** Escapes `%`, `_` and `\` so user text can sit inside a LIKE pattern. */
export const escapeLike = (text: string): string => text.replace(/[\\%_]/g, (c) => `\\${c}`);
