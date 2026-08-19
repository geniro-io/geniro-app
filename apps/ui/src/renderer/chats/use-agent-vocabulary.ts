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
 * How many times a failed probe is retried, and how long after the last
 * failure.
 *
 * A failure used to be final for the session, which is what turned one bad
 * probe into "I can't choose cursor models": the retry lives in an effect keyed
 * on `[kind, fetchFor]`, and re-opening the picker changes neither — so the
 * empty list was served on every later render, indistinguishable from a CLI
 * that genuinely offers none. Reported against a cursor picker showing only
 * "default model" while the daemon answered the same request with 15 models in
 * 7.8s.
 *
 * Bounded and spaced because a probe is not free: each attempt spawns a real
 * `cursor-agent acp` and handshakes twice. Three tries covers a CLI briefly
 * busy or a cold start; past that the empty list is the honest answer and the
 * user still has "default model", which starts a run.
 */
const MAX_FETCH_ATTEMPTS = 3;
const RETRY_DELAY_MS = 4_000;

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
   * every render would refetch in a loop. A caller that varies by
   * {@link variant} closes over it here and declares it below.
   */
  fetchFor: ((kind: CliKind) => Promise<T[]>) | null,
  /**
   * A second dimension of the same question, folded into the cache key.
   *
   * The effort listing needs it: its levels belong to the MODEL, not only to
   * the CLI, so two models are two answers and a kind-only key served the
   * previous model's list from cache forever. Null for a vocabulary that is
   * genuinely per-kind (the model picker), which keeps its key exactly what it
   * was.
   */
  variant: string | null = null,
): AgentVocabularyState<T> {
  const cacheRef = useRef(new Map<string, T[]>());
  /** Failed attempts per key, so a retry loop cannot outrun its own bound. */
  const attemptsRef = useRef(new Map<string, number>());
  // `\u0000` because neither a kind nor a model can contain it, so no pair of
  // (kind, model) can collide with another by concatenation.
  const key = kind === null ? null : `${kind}\u0000${variant ?? ''}`;
  /** Bumped to re-run the fetch effect after a failure — see the constants. */
  const [retry, setRetry] = useState(0);
  // What the last finished fetch answered, and WHICH kind it answered for.
  // Only ever read when it matches the kind being asked about.
  const [answered, setAnswered] = useState<{
    key: string;
    items: T[];
  } | null>(null);

  useEffect(() => {
    if (
      kind === null ||
      key === null ||
      fetchFor === null ||
      cacheRef.current.has(key)
    ) {
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
    setAnswered((previous) => (previous?.key === key ? null : previous));
    let stale = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void fetchFor(kind)
      .then((fetched) => {
        cacheRef.current.set(key, fetched);
        if (!stale) {
          setAnswered({ key, items: fetched });
        }
      })
      .catch(() => {
        // Deliberately NOT cached: a failed probe is not an answer about the
        // CLI, and selecting it again should ask again.
        if (stale) {
          return;
        }
        setAnswered({ key, items: [] });
        // ...and ASKING again is what this schedules. Without it "should ask
        // again" was never true: nothing re-runs this effect on its own, so the
        // empty list stood until the user switched agents or restarted.
        const attempts = (attemptsRef.current.get(key) ?? 0) + 1;
        attemptsRef.current.set(key, attempts);
        if (attempts < MAX_FETCH_ATTEMPTS) {
          timer = setTimeout(
            () => setRetry((tick) => tick + 1),
            RETRY_DELAY_MS,
          );
        }
      });
    return () => {
      // The user switched agents mid-flight — a late answer for the previous
      // kind must not land in the picker for the current one.
      stale = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    };
  }, [kind, key, fetchFor, retry]);

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
  if (kind === null || key === null || fetchFor === null) {
    return { items: NOTHING_YET, loading: false };
  }
  const cached = cacheRef.current.get(key);
  if (cached) {
    return { items: cached, loading: false };
  }
  if (answered?.key === key) {
    return { items: answered.items, loading: false };
  }
  return { items: NOTHING_YET, loading: true };
}
