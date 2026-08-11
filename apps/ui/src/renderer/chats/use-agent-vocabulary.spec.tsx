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
    expect(probe.latest()).toEqual({ items: ['opus', 'sonnet'], loading: false });
    expect(claudeCalls).toBe(1);
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
