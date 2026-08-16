import { useEffect, useRef, useState } from 'react';

import type { CliKind } from '../../shared/contracts';

export type AgentVocabularyState<T> = {
  items: T[];
  /** True while the first fetch for this kind is in flight and nothing is cached. */
  loading: boolean;
};

/**
 * The "nothing known yet" answer, as ONE array rather than a fresh literal per
 * render: a consumer whose effect depends on the list would otherwise re-run on
 * every render of an agent whose vocabulary has not arrived.
 */
const NOTHING_YET: never[] = [];

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
  // What the last finished fetch answered, and WHICH kind it answered for.
  // Only ever read when it matches the kind being asked about.
  const [answered, setAnswered] = useState<{
    kind: CliKind;
    items: T[];
  } | null>(null);

  useEffect(() => {
    if (kind === null || fetchFor === null || cacheRef.current.has(kind)) {
      return;
    }
    // An existing answer for the kind we are about to fetch can only be a
    // FAILED one: a success is cached, and a cached kind returned above. Drop
    // it, or the retry this effect is starting renders as `loading: false` with
    // an empty list — the exact shape of a CLI that genuinely offers no models,
    // so a probe that is recovering looks like a permanent absence for the
    // several seconds a cursor probe takes.
    //
    // Cleared HERE and not resolved during render, unlike the sibling reading
    // in `useChatMetrics`. The render has no way to tell a failure that is
    // about to be retried from one that has settled and is not, and the only
    // distinguishing fact — that this effect is about to run — is the effect
    // itself. Gating the branch on the cache instead spins the chip forever:
    // a success is already served by the cache above, so that branch would
    // only ever see failures, and a failure nothing retries has no later render
    // to correct it. The cost of clearing here is one frame of the stale
    // reading before this commits, against the multi-second window the CLI
    // takes to answer.
    setAnswered((previous) => (previous?.kind === kind ? null : previous));
    let stale = false;
    void fetchFor(kind)
      .then((fetched) => {
        cacheRef.current.set(kind, fetched);
        if (!stale) {
          setAnswered({ kind, items: fetched });
        }
      })
      .catch(() => {
        // Deliberately NOT cached: a failed probe is not an answer about the
        // CLI, and selecting it again should ask again.
        if (!stale) {
          setAnswered({ kind, items: [] });
        }
      });
    return () => {
      // The user switched agents mid-flight — a late answer for the previous
      // kind must not land in the picker for the current one.
      stale = true;
    };
  }, [kind, fetchFor]);

  // Resolved DURING RENDER, not in an effect, and that is the whole point: the
  // answer must belong to the kind being asked about in THIS commit. An
  // effect-set state is always one commit late, so the render that switches
  // kinds still read the previous CLI's list — and a consumer that acts on the
  // list on mount acted on it. Measured in the graph builder (2026-08-15): the
  // node inspector adopts the first model for a model-less node, so adding a
  // cursor node while a claude node was selected stamped the cursor node with
  // claude's `claude-fable-5[1m]`, which then went to disk in the workflow YAML
  // and to the CLI at run time. Both directions reproduced; the run's own
  // transcript recorded "agent does not offer the model 'claude-fable-5'".
  // Holding the previous list is not a flicker either: a cursor model probe
  // spawns a real `cursor-agent acp` and handshakes twice (7.0s cold).
  if (kind === null || fetchFor === null) {
    return { items: NOTHING_YET, loading: false };
  }
  const cached = cacheRef.current.get(kind);
  if (cached) {
    return { items: cached, loading: false };
  }
  if (answered?.kind === kind) {
    return { items: answered.items, loading: false };
  }
  return { items: NOTHING_YET, loading: true };
}
