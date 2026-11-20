export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/** Short plain-text preview used for cards. Whitespace is collapsed. */
export function makeExcerpt(content: string, maxChars = 240): string {
  const flat = content.slice(0, maxChars * 4).replace(/\s+/g, " ").trim();
  if (flat.length <= maxChars) return flat;
  const cut = flat.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

export const RESERVED_USERNAMES = new Set([
  "admin", "administrator", "api", "auth", "discover", "inkspire", "login", "logout",
  "me", "moderator", "profile", "register", "root", "settings", "signup", "support",
  "system", "write", "works", "null", "undefined",
]);

export const USERNAME_PATTERN = /^[a-z0-9_]{3,24}$/;
