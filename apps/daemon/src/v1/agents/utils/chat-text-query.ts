/** A query longer than this many words is cut; nobody remembers more. */
const MAX_QUERY_TERMS = 30;

/** A word that carries at least one letter or digit — anything FTS5 indexes. */
const INDEXABLE = /[\p{L}\p{N}]/u;

/**
 * A query's words in the order typed. Control characters split words like
 * spaces do: a NUL inside a word would otherwise reach SQLite and end the
 * MATCH string literal early.
 */
function queryWords(query: string): string[] {
  return query.split(/[\s\p{Cc}]+/u).slice(0, MAX_QUERY_TERMS);
}

/**
 * The searchable pieces of a query, lowercased — what a snippet is windowed
 * on. Split the way FTS5's tokenizer splits (on anything that is not a letter
 * or digit), so `foo-bar` is looked for as `foo` and `bar`; `OR` is left out.
 */
export function chatTextQueryTerms(query: string): string[] {
  return queryWords(query)
    .filter((word) => word !== 'OR')
    .flatMap((word) => word.toLowerCase().split(/[^\p{L}\p{N}]+/u))
    .filter((piece) => piece.length > 0);
}

/**
 * What a person typed, as an FTS5 MATCH expression that cannot fail to parse.
 *
 * Each word becomes a quoted PREFIX term (`"платеж"*`), so a stem finds its
 * forms — FTS5 has no Russian stemmer, and `платеж` finding `платежей` is the
 * point — and a half-typed identifier finds the whole one; a word of one
 * character is matched exactly instead. Quoting is what
 * makes arbitrary input safe: inside double quotes FTS5 reads every character
 * as text, so `-`, `:`, `(`, `NEAR` and the rest are words, never syntax; a
 * quote inside a word is doubled. A word with no letter or digit is dropped:
 * FTS5 would tokenize it to nothing.
 *
 * Every word must match, and a bare uppercase `OR` makes the words either side
 * of it alternatives: `idempotency retry OR backoff` is idempotency AND (retry
 * OR backoff). The groups are parenthesised and joined with an explicit AND
 * because FTS5 binds implicit AND tighter than OR — written flat, the same
 * query would also match a message that only says "backoff".
 *
 * Returns null when nothing searchable is left.
 */
export function chatTextMatchQuery(query: string): string | null {
  const groups: string[][] = [];
  let joinNext = false;
  for (const word of queryWords(query)) {
    if (word === 'OR') {
      joinNext = groups.length > 0;
      continue;
    }
    if (!INDEXABLE.test(word)) {
      continue;
    }
    const quoted = `"${word.replaceAll('"', '""')}"`;
    // A one-character prefix matches nearly every row it is allowed near, so
    // a word whose last indexed piece is one character (`x`, `C#`, `a-`) is
    // looked for as itself. The piece, not the word: FTS5 applies `*` to the
    // phrase's last token, and `C#` is the token `c`.
    const last =
      word
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean)
        .at(-1) ?? '';
    const term = [...last].length === 1 ? quoted : `${quoted}*`;
    if (joinNext) {
      groups[groups.length - 1]!.push(term);
    } else {
      groups.push([term]);
    }
    joinNext = false;
  }
  if (groups.length === 0) {
    return null;
  }
  return groups
    .map((group) =>
      group.length === 1 ? group[0]! : `(${group.join(' OR ')})`,
    )
    .join(' AND ');
}
