export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const badRequest = (code: string, message: string, details?: unknown) =>
  new AppError(code, message, 400, details);

export const unauthorized = (
  code = "UNAUTHENTICATED",
  message = "Authentication is required.",
) => new AppError(code, message, 401);

export const forbidden = (
  code = "FORBIDDEN",
  message = "You do not have permission to do that.",
) => new AppError(code, message, 403);

export const notFound = (code = "NOT_FOUND", message = "The requested resource was not found.") =>
  new AppError(code, message, 404);

export const conflict = (code: string, message: string) => new AppError(code, message, 409);

export const unavailable = (code: string, message: string) => new AppError(code, message, 503);
