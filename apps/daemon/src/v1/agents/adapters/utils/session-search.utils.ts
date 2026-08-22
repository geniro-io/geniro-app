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
 * The query as terms, ALL of which a session must answer for.
 *
 * Terms rather than the whole string, because that is how somebody remembers a
 * conversation from last week — in fragments, one from the project and one from
 * what was said ("auth geniro"), in whatever order they come to mind.
 */
export function searchTerms(query: string | null): string[] {
  return (query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
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
