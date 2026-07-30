import { useEffect, useRef, useState } from 'react';

import type { CliKind } from '../../shared/contracts';

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
 */
export function useAgentVocabulary<T>(
  kind: CliKind | null,
  /**
   * Fetches the list for one kind, or null when there is no client yet. Must be
   * referentially stable across renders for a given client — a fresh closure
   * every render would refetch in a loop.
   */
  fetchFor: ((kind: CliKind) => Promise<T[]>) | null,
): T[] {
  const cacheRef = useRef(new Map<CliKind, T[]>());
  const [list, setList] = useState<T[]>([]);

  useEffect(() => {
    if (kind === null || fetchFor === null) {
      setList([]);
      return;
    }
    const cached = cacheRef.current.get(kind);
    if (cached) {
      setList(cached);
      return;
    }
    let stale = false;
    void fetchFor(kind)
      .then((fetched) => {
        cacheRef.current.set(kind, fetched);
        if (!stale) {
          setList(fetched);
        }
      })
      .catch(() => {
        if (!stale) {
          setList([]);
        }
      });
    return () => {
      // The user switched agents mid-flight — a late answer for the previous
      // kind must not land in the picker for the current one.
      stale = true;
    };
  }, [kind, fetchFor]);

  return list;
}
