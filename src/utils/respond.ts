/** Every successful response uses the same envelope. */
export const ok = <T>(data: T) => ({ success: true as const, data });

export const okPage = <T>(items: T[], nextCursor: string | null) => ({
  success: true as const,
  data: { items, nextCursor },
});
