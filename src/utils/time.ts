/** UTC bucket keys used by the analytics tables. */
export const dayKey = (d: Date) => d.toISOString().slice(0, 10);
export const monthKey = (d: Date) => `${d.toISOString().slice(0, 7)}-01`;
export const yearKey = (d: Date) => d.getUTCFullYear();
