import type { AgentModel } from '../adapter.types';

/**
 * The set offered when the CLI cannot be asked — an install too old to have
 * the `models` subcommand, or one that is not signed in. These are the ids
 * cursor-agent's own `--model` help gives as examples, so they are the only
 * ones documented to work without asking the account.
 */
export const CURSOR_BUILTIN_MODELS: AgentModel[] = [
  { id: 'gpt-5', label: 'gpt-5', source: 'builtin' },
  { id: 'sonnet-4', label: 'sonnet-4', source: 'builtin' },
  { id: 'sonnet-4-thinking', label: 'sonnet-4-thinking', source: 'builtin' },
];

/**
 * Parse `cursor-agent models` output.
 *
 * The command prints the account's model ids one per line — compound ids that
 * flatten model × reasoning effort (`gpt-5.2-high`), so the list runs long.
 * They are kept VERBATIM: only cursor knows which spellings `--model` honours,
 * and its own families are spelled inconsistently (`claude-4.6-opus` beside
 * `claude-opus-4-8`), so deriving "base" ids here would invent ids the CLI may
 * reject. The picker has a search field; a long, correct list beats a short,
 * guessed one.
 *
 * Returns null — meaning "could not be asked", so the caller falls back —
 * for empty output and for the unauthenticated notice the CLI prints instead
 * of a list.
 */
export function parseCursorModels(stdout: string | null): AgentModel[] | null {
  const trimmed = (stdout ?? '').trim();
  if (!trimmed || /no models available/i.test(trimmed)) {
    return null;
  }
  const seen = new Set<string>();
  const models: AgentModel[] = [];
  for (const raw of trimmed.split('\n')) {
    const line = raw.trim();
    // Skip blanks, comments, a heading line, and the "(current)"/"(default)"
    // tags cursor appends — those are per-session state, not part of the id.
    if (
      !line ||
      line.startsWith('#') ||
      /^(available )?models:?$/i.test(line)
    ) {
      continue;
    }
    const match = /^([A-Za-z0-9][A-Za-z0-9._/:@-]*)/.exec(line);
    const id = match?.[1];
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    models.push({ id, label: id, source: 'cli' });
  }
  return models.length > 0 ? models : null;
}
