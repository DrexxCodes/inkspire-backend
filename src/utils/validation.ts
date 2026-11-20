import { z } from "zod";
import { AppError } from "./errors.js";

/** Validates untrusted input and throws a structured VALIDATION_ERROR. */
export function parse<S extends z.ZodTypeAny>(schema: S, data: unknown): z.output<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new AppError(
      "VALIDATION_ERROR",
      "The request is invalid.",
      400,
      result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    );
  }
  return result.data;
}

export const idParam = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
