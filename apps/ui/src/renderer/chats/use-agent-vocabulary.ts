import { useEffect, useRef, useState } from 'react';

import type { CliKind } from '../../shared/contracts';

export type AgentVocabularyState<T> = {
  items: T[];
  /** True while the first fetch for this kind is in flight and nothing is cached. */
  loading: boolean;
};

/**
 * One agent CLI's vocabulary for some picker — its models, its reasoning-effort
 * levels — fetched from the daemon and cached per kind for the session.
 *
 * Nothing about any vocabulary is hardcoded on this side: each is a CLI's own,
 * the daemon asks the CLI (or its adapter) for it, and this hook only fetches
 * and caches. Callers supply the fetch; everything else — the per-kind cache,
 * the null-kind reset, the failure fallback and the stale-response guard — is
 * identical for every vocabulary and lives here once.
 *
 * An EMPTY list is a meaningful answer, not only an error: it is what a CLI
 * with no such control returns, and the composer omits that chip entirely
 * rather than offering a control over nothing. A failed fetch yields the same
 * empty list, which degrades the picker rather than the run.
 *
 * {@link AgentVocabularyState.loading} is true only in the window before the
 * first answer for a kind arrives — long enough for cursor's ACP model probe
 * that the model chip must not read as "default model" during.
 */
export function useAgentVocabulary<T>(
  kind: CliKind | null,
  /**
   * Fetches the list for one kind, or null when there is no client yet. Must be
   * referentially stable across renders for a given client — a fresh closure
   * every render would refetch in a loop.
   */
  fetchFor: ((kind: CliKind) => Promise<T[]>) | null,
): AgentVocabularyState<T> {
  const cacheRef = useRef(new Map<CliKind, T[]>());
  const [state, setState] = useState<AgentVocabularyState<T>>({
    items: [],
    loading: false,
  });

  useEffect(() => {
    if (kind === null || fetchFor === null) {
      setState({ items: [], loading: false });
      return;
    }
    const cached = cacheRef.current.get(kind);
    if (cached) {
      setState({ items: cached, loading: false });
      return;
    }
    // Nothing known about THIS kind yet, so show nothing — never the kind we
    // were showing a moment ago. Holding the previous list across the switch
    // offers one CLI's vocabulary under another's name, and the window is not
    // a flicker: a cursor model probe spawns a real `cursor-agent acp` and
    // handshakes twice (7.0s cold), so a cursor target sat there offering
    // claude's models for seconds.
    setState({ items: [], loading: true });
    let stale = false;
    void fetchFor(kind)
      .then((fetched) => {
        cacheRef.current.set(kind, fetched);
        if (!stale) {
          setState({ items: fetched, loading: false });
        }
      })
      .catch(() => {
        if (!stale) {
          setState({ items: [], loading: false });
        }
      });
    return () => {
      // The user switched agents mid-flight — a late answer for the previous
      // kind must not land in the picker for the current one.
      stale = true;
    };
  }, [kind, fetchFor]);

  return state;
}
