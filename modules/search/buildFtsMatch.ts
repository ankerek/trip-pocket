// Minimum codepoints in the user's input before we hit FTS5. Trigram tokenizer
// indexes every 3-codepoint substring, so a 1- or 2-character query never
// matches anything — short-circuit so the search screen shows the empty-state
// hint instead of running a no-op query.
const MIN_QUERY_CODEPOINTS = 3;

/**
 * Build an FTS5 MATCH expression from raw user input.
 *
 * Returns the bound parameter string for `screenshots_fts MATCH ?`, or
 * `null` if the input is empty / below the trigram minimum (in which case
 * the caller should not run the query).
 *
 * Behavior:
 *  - Trim outer whitespace.
 *  - If the trimmed length (in codepoints) is < 3, return null.
 *  - Split on whitespace into tokens.
 *  - FTS5-quote each token (wrap in `"…"`, double any embedded `"`). Quoting
 *    alone is enough to neutralize the FTS5 operator alphabet (`*`, `+`, `-`,
 *    `(`, `)`, `:`, `^`, etc.) — inside double quotes everything is literal.
 *  - Join tokens with single spaces. FTS5 interprets space-separated tokens
 *    as AND.
 */
export function buildFtsMatch(rawInput: string): string | null {
  const trimmed = rawInput.trim();
  // Codepoint count (handles surrogate pairs); standard `.length` would
  // miscount non-BMP characters. CJK characters in the BMP behave the same
  // either way, but counting codepoints is the right contract.
  const codepoints = [...trimmed].length;
  if (codepoints < MIN_QUERY_CODEPOINTS) return null;

  const tokens = trimmed.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return null;

  return tokens.map(quoteToken).join(' ');
}

function quoteToken(token: string): string {
  return `"${token.replace(/"/g, '""')}"`;
}
