// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import type { CliKind } from '../../shared/contracts';
import { useAgentVocabulary } from './use-agent-vocabulary';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

/** A promise plus the handle to settle it from the test body. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Drive the hook for one kind at a time, exposing its latest value and a way
 * to re-render with a different kind — which is the transition under test.
 */
function mount(
  initialKind: CliKind | null,
  fetchFor: (kind: CliKind) => Promise<string[]>,
): {
  latest: () => { items: string[]; loading: boolean };
  setKind: (kind: CliKind | null) => void;
} {
  let latest = { items: [] as string[], loading: false };
  let kind = initialKind;
  function Probe({ current }: { current: CliKind | null }): null {
    latest = useAgentVocabulary(current, fetchFor);
    return null;
  }
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const render = (): void => {
    root?.render(<Probe current={kind} />);
  };
  act(render);
  return {
    latest: () => latest,
    setKind: (next) => {
      kind = next;
      act(render);
    },
  };
}

describe('useAgentVocabulary', () => {
  it('drops the previous kind’s list while the new kind is still being fetched', async () => {
    const cursor = deferred<string[]>();
    const fetchFor = (kind: CliKind): Promise<string[]> =>
      kind === 'claude'
        ? Promise.resolve(['opus', 'sonnet', 'haiku'])
        : cursor.promise;

    const probe = mount('claude', fetchFor);
    await act(async () => {
      await Promise.resolve();
    });
    expect(probe.latest()).toEqual({
      items: ['opus', 'sonnet', 'haiku'],
      loading: false,
    });

    // The switch the user makes. Cursor's probe spawns a real CLI and takes
    // seconds, so this pending window is the whole bug: the picker must not go
    // on offering claude's models under a cursor target.
    probe.setKind('cursor-agent');
    expect(probe.latest()).toEqual({ items: [], loading: true });

    await act(async () => {
      cursor.resolve(['cursor-grok-4.5', 'composer-2.5']);
      await cursor.promise;
    });
    expect(probe.latest()).toEqual({
      items: ['cursor-grok-4.5', 'composer-2.5'],
      loading: false,
    });
  });

  it('serves a cached kind from the cache on return, with no second fetch', async () => {
    let claudeCalls = 0;
    const fetchFor = (kind: CliKind): Promise<string[]> => {
      if (kind === 'claude') {
        claudeCalls += 1;
        return Promise.resolve(['opus', 'sonnet']);
      }
      return Promise.resolve(['composer-2.5']);
    };

    const probe = mount('claude', fetchFor);
    await act(async () => {
      await Promise.resolve();
    });
    probe.setKind('cursor-agent');
    await act(async () => {
      await Promise.resolve();
    });
    expect(probe.latest()).toEqual({
      items: ['composer-2.5'],
      loading: false,
    });

    // Back to a kind already in the cache: served from it, so the clear above
    // never costs a round trip. (The absence of an intermediate blank FRAME is
    // deliberately not claimed here — this harness reads only the latest
    // committed value, so it could not observe one either way.)
    probe.setKind('claude');
    expect(probe.latest()).toEqual({
      items: ['opus', 'sonnet'],
      loading: false,
    });
    expect(claudeCalls).toBe(1);
  });

  it('never answers a render with the kind it was asked about the render before', async () => {
    // `act` flushes effects, so the tests above can only ever read the SETTLED
    // value — which is why an effect-based reset looked correct for two
    // milestones. What a consumer's own mount effect reads is the value from
    // the render that switched kinds, one commit earlier, and that render used
    // to carry the previous CLI's list.
    //
    // Measured in the graph builder (2026-08-15): the node inspector adopts the
    // first model for a model-less node, so adding a cursor node while a claude
    // node was selected wrote claude's `claude-fable-5[1m]` onto the cursor
    // node — into the workflow YAML and then into the run, whose transcript
    // recorded "agent does not offer the model 'claude-fable-5'".
    const seen: { kind: CliKind | null; items: string[] }[] = [];
    const fetchFor = (kind: CliKind): Promise<string[]> =>
      Promise.resolve(kind === 'claude' ? ['opus', 'sonnet'] : ['auto-smart']);

    let kind: CliKind | null = 'claude';
    function Probe({ current }: { current: CliKind | null }): null {
      const { items } = useAgentVocabulary(current, fetchFor);
      seen.push({ kind: current, items });
      return null;
    }
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const render = (): void => {
      root?.render(<Probe current={kind} />);
    };
    act(render);
    await act(async () => {
      await Promise.resolve();
    });

    kind = 'cursor-agent';
    act(render);

    // The FIRST render under the new kind — the one a child mounts in.
    expect(seen.find((s) => s.kind === 'cursor-agent')).toEqual({
      kind: 'cursor-agent',
      items: [],
    });
    // And no render, at any point, paired one CLI's kind with another's list.
    expect(
      seen.filter((s) => s.kind === 'cursor-agent' && s.items.includes('opus')),
    ).toEqual([]);
  });

  it('shows a RETRY after a failed probe as in flight, not as an empty CLI', async () => {
    // A failed probe is deliberately not cached, so re-selecting that CLI asks
    // again. But the failure left `{ items: [], loading: false }` behind, which
    // is byte-for-byte what a CLI with no models of its own answers — so the
    // second attempt rendered as a settled absence and the chip stayed hidden
    // for the several seconds a cursor probe takes, then appeared out of
    // nowhere. A recovering probe has to read as recovering.
    const retry = deferred<string[]>();
    let cursorCalls = 0;
    const fetchFor = (kind: CliKind): Promise<string[]> => {
      if (kind !== 'cursor-agent') {
        return Promise.resolve(['opus']);
      }
      cursorCalls += 1;
      return cursorCalls === 1
        ? Promise.reject(new Error('probe failed'))
        : retry.promise;
    };

    // Claude first, so it is CACHED. That is what makes the round trip back to
    // cursor reach the stale failure: a cached kind's effect returns before it
    // fetches, so nothing overwrites the failed answer on the way past. Start on
    // cursor instead and claude's own reply clears it in passing, which is why
    // the defect survived a spec that switched between two uncached CLIs.
    const probe = mount('claude', fetchFor);
    await act(async () => {
      await Promise.resolve();
    });

    probe.setKind('cursor-agent');
    await act(async () => {
      await Promise.resolve();
    });
    expect(probe.latest()).toEqual({ items: [], loading: false });

    probe.setKind('claude');
    probe.setKind('cursor-agent');

    expect(probe.latest()).toEqual({ items: [], loading: true });
    // Asked again, exactly once — the failure was never cached, and the retry
    // is not a duplicate of it.
    expect(cursorCalls).toBe(2);

    await act(async () => {
      retry.resolve(['composer-2.5']);
      await retry.promise;
    });
    expect(probe.latest()).toEqual({
      items: ['composer-2.5'],
      loading: false,
    });
  });

  it('clears the list when the kind goes away entirely', async () => {
    const probe = mount('claude', (): Promise<string[]> =>
      Promise.resolve(['opus']),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(probe.latest()).toEqual({ items: ['opus'], loading: false });

    probe.setKind(null);
    expect(probe.latest()).toEqual({ items: [], loading: false });
  });
});
