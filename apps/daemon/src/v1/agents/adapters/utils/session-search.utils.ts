import type { AgentSessionRecord } from '../adapter.types';

/**
 * Matching a picker query against what a session row already STATES.
 *
 * Agent-agnostic on purpose, and it is the half of the search every adapter can
 * answer: a row's title and its folder are the two fields
 * {@link AgentSessionRecord} exists to carry, so no CLI-specific knowledge is
 * involved in asking whether they contain a word. What differs per CLI is only
 * whether there is anything MORE to search — the conversation itself — and that
 * is `AdapterConfig.sessions.contentSearchUnavailableReason`.
 *
 * Living here rather than in one adapter is what keeps the two CLIs answering
 * the same question. `AgentSessionsInput.query` requires every implementation to
 * apply the query itself; two hand-written matchers is how one of them comes to
 * be case-sensitive, or to match the whole phrase where the other matches terms.
 */

/**
 * How many terms one query can carry before the rest is ignored.
 *
 * The DTO bounds the query's LENGTH (`listAgentSessionsQuerySchema.query`,
 * `apps/daemon/src/v1/agents/dto/skills.dto.ts`, `.max(200)`); this bounds
 * what splitting it can produce, which is a different quantity, and the two
 * must not disagree: a real pasted phrase at that 200-character ceiling runs
 * to roughly 28-40 words at ordinary English lengths, so a term cap lower
 * than that would silently drop words from exactly the query the DTO's own
 * doc calls "generous enough for a real pasted search phrase". 50 sits
 * comfortably above that real-text range while still bounding the
 * pathological case to a fixed cost — a 200-character string built entirely
 * of one-character "words" can reach roughly 100 terms, which is what
 * `unmatchedTerms` (and, on the claude path, a per-term file search) would
 * otherwise be handed with no ceiling of its own.
 */
const MAX_SEARCH_TERMS = 50;

/**
 * The query as terms, ALL of which a session must answer for.
 *
 * Terms rather than the whole string, because that is how somebody remembers a
 * conversation from last week — in fragments, one from the project and one from
 * what was said ("auth geniro"), in whatever order they come to mind.
 */
export function searchTerms(query: string | null): string[] {
  return (query ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, MAX_SEARCH_TERMS);
}

/**
 * The terms the row's own title and folder do not account for.
 *
 * Returned rather than a yes/no because the expensive half of a search only
 * needs to look for what is left: a query naming a project and a phrase has its
 * project half answered for free, and only the phrase has to be read out of the
 * conversation.
 */
export function unmatchedTerms(
  terms: readonly string[],
  session: Pick<AgentSessionRecord, 'title' | 'cwd'>,
): string[] {
  const stated = `${session.title ?? ''} ${session.cwd ?? ''}`.toLowerCase();
  return terms.filter((term) => !stated.includes(term));
}

/** The rows whose title or folder answers for every term; all rows if none. */
export function matchSessions<
  T extends Pick<AgentSessionRecord, 'title' | 'cwd'>,
>(sessions: readonly T[], query: string | null): T[] {
  const terms = searchTerms(query);
  if (terms.length === 0) {
    return [...sessions];
  }
  return sessions.filter(
    (session) => unmatchedTerms(terms, session).length === 0,
  );
}
