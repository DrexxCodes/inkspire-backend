/**
 * Content chunking.
 *
 * Firestore documents are limited to ~1 MiB, so literary content is split into chunks that
 * each stay under a configurable byte threshold. Sizes are always measured in UTF-8 bytes
 * (never `string.length`) so emoji, accents and non-Latin scripts are handled correctly.
 *
 * Boundary preference, in order: paragraph, newline, sentence, word, then a raw character
 * cut as an absolute fallback. Chunks are lossless: joining them reproduces the input exactly.
 */

/** Firestore hard limit for a single document. */
export const FIRESTORE_DOC_LIMIT_BYTES = 1_048_576;
/** Highest threshold an administrator may configure. Leaves headroom for field names and metadata. */
export const MAX_CHUNK_THRESHOLD_BYTES = 900_000;
/** The longest UTF-8 encoding of a single character. A threshold below this could never progress. */
const MIN_THRESHOLD_BYTES = 4;

export const utf8Bytes = (text: string): number => Buffer.byteLength(text, "utf8");

/**
 * Chunk document ids are zero padded so lexical id order equals chunk order. That lets a
 * reader fetch "everything after chunk N" with a plain document id range query.
 */
export const chunkId = (prefix: string, index: number) => `${prefix}${String(index).padStart(6, "0")}`;

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** Largest prefix length (in UTF-16 code units) whose UTF-8 size is <= maxBytes. */
function largestFittingPrefix(text: string, maxBytes: number): number {
  // Every UTF-16 code unit needs at least one UTF-8 byte, so a fitting prefix cannot be
  // longer than maxBytes code units.
  let lo = 0;
  let hi = Math.min(text.length, maxBytes);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (utf8Bytes(text.slice(0, mid)) <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  // Never cut between the two halves of a surrogate pair.
  if (
    lo > 0 &&
    lo < text.length &&
    isHighSurrogate(text.charCodeAt(lo - 1)) &&
    isLowSurrogate(text.charCodeAt(lo))
  ) {
    lo -= 1;
  }
  return lo;
}

function endOfLastMatch(window: string, pattern: RegExp, minEnd: number): number {
  let end = -1;
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(window)) !== null) {
    const candidate = match.index + match[0].length;
    if (candidate >= minEnd) end = candidate;
    if (match[0].length === 0) pattern.lastIndex++;
  }
  return end;
}

const PARAGRAPH = /\r?\n[ \t]*\r?\n/g;
const SENTENCE = /[.!?…]+["'”’)\]]*\s/g;

/** Chooses where to cut within text[0, limit). Always returns a value in [1, limit]. */
function findBoundary(text: string, limit: number): number {
  const window = text.slice(0, limit);
  // Do not accept a boundary that would make a chunk less than half the allowed size.
  const minEnd = Math.max(1, Math.floor(limit / 2));

  const paragraph = endOfLastMatch(window, PARAGRAPH, minEnd);
  if (paragraph > 0) return paragraph;

  const newline = window.lastIndexOf("\n");
  if (newline + 1 >= minEnd) return newline + 1;

  const sentence = endOfLastMatch(window, SENTENCE, minEnd);
  if (sentence > 0) return sentence;

  for (let i = window.length - 1; i + 1 >= minEnd; i--) {
    if (/\s/.test(window[i]!)) return i + 1;
  }

  return limit;
}

/**
 * Splits content into chunks of at most `maxBytes` UTF-8 bytes each.
 * Returns [] for empty content. Throws RangeError for an unusable threshold.
 */
export function splitIntoChunks(content: string, maxBytes: number): string[] {
  if (!Number.isInteger(maxBytes) || maxBytes < MIN_THRESHOLD_BYTES) {
    throw new RangeError(`Chunk threshold must be an integer of at least ${MIN_THRESHOLD_BYTES} bytes.`);
  }
  const chunks: string[] = [];
  let rest = content;
  while (rest.length > 0) {
    if (utf8Bytes(rest) <= maxBytes) {
      chunks.push(rest);
      break;
    }
    const limit = largestFittingPrefix(rest, maxBytes);
    const cut = findBoundary(rest, limit);
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  return chunks;
}

/** Defensive check run before anything is written. */
export function assertChunksWithinLimit(chunks: string[], maxBytes: number): void {
  for (const [i, chunk] of chunks.entries()) {
    const size = utf8Bytes(chunk);
    if (size > maxBytes || size >= FIRESTORE_DOC_LIMIT_BYTES) {
      throw new RangeError(`Chunk ${i} is ${size} bytes which exceeds the safe threshold.`);
    }
  }
}
