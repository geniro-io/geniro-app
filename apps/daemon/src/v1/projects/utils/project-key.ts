/** How many characters a project key may take. */
const MAX_KEY = 4;

/** The fallback for a name with no letters or digits in it at all. */
const FALLBACK = 'TSK';

/**
 * A short key for a project, derived from its name — `Geniro` → `GEN`,
 * `Simpler Case Management` → `SCM`.
 *
 * It is what makes a task's identifier readable: `GEN-12` says which board a
 * card belongs to in a way a UUID never will, which is the whole of the ask
 * ("нужно добавить номер, вот как в linear, то есть по первым буквам проекта и
 * номер"). Linear's own scheme, and the shape everyone already reads.
 *
 * DERIVED once and then STORED on the row, never recomputed: renaming a
 * project must not silently renumber every card that was ever mentioned in a
 * commit message or a chat. That is also why this takes a name rather than a
 * project — it runs at creation and at the backfill, and nowhere else.
 *
 * Multi-word names take one letter per word, single words take the leading
 * letters; digits count as letters here, so `M2 Cases` keeps its `M2`. A name
 * that yields nothing at all (emoji, punctuation, a script with no ASCII form)
 * falls back rather than producing an empty key, since an identifier of the
 * form `-12` is worse than a generic one.
 */
export function projectKey(name: string): string {
  const words = name
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0)
    // Latin letters and digits only: a key is typed and read aloud, and a
    // mixed-script one cannot be either.
    .map((word) => word.replace(/[^A-Za-z0-9]/g, ''))
    .filter((word) => word.length > 0);
  if (words.length === 0) {
    return FALLBACK;
  }
  const key =
    words.length === 1
      ? (words[0] as string).slice(0, 3)
      : words.map((word) => word[0] as string).join('');
  return key.slice(0, MAX_KEY).toUpperCase();
}

/**
 * A card's identifier, as it is read and written everywhere.
 *
 * One function because three surfaces draw it — the board card, the detail
 * panel and the accessible name — and `${key}-${number}` written three times
 * is how one of them comes to say `GEN #12`.
 *
 * Null when the card predates numbering and the backfill has not reached it,
 * so a caller draws nothing rather than `GEN-0`, which names a card that does
 * not exist.
 */
export function taskIdentifier(
  key: string | null,
  number: number | null,
): string | null {
  if (key === null || key === '' || number === null || number <= 0) {
    return null;
  }
  return `${key}-${number}`;
}
