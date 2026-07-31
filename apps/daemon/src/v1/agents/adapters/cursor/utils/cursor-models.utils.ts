import type { AgentModel } from '../../adapter.types';
import {
  CURSOR_MODEL_ID_PATTERN,
  CURSOR_MODELS_HEADING_PATTERN,
  CURSOR_NO_MODELS_PATTERN,
} from '../cursor.const';

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
  if (!trimmed || CURSOR_NO_MODELS_PATTERN.test(trimmed)) {
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
      CURSOR_MODELS_HEADING_PATTERN.test(line)
    ) {
      continue;
    }
    const match = CURSOR_MODEL_ID_PATTERN.exec(line);
    const id = match?.[1];
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    models.push({ id, label: id, source: 'cli' });
  }
  return models.length > 0 ? models : null;
}
