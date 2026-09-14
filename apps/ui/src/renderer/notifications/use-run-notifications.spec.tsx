// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GeniroApi } from '../../shared/contracts';
import { createPreloadStub } from '../__fixtures__/preload-stub';
import type { RunStatusKind } from '../chats/run-status';
import { RECENT_LAUNCH_MS } from './run-notifications';
import { useRunNotifications } from './use-run-notifications';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

interface Row {
  id: string;
  status: RunStatusKind;
  shellsOpen: number;
}

// Module scope, so the hook's effect re-runs on the run list alone — the way
// `Chats` hands it memoized readers.
const statusOf = (run: Row): RunStatusKind => run.status;
const labelOf = (run: Row): string => run.id;
const awaitingOf = (): null => null;
const shellsOpenOf = (run: Row): number => run.shellsOpen;

function Probe({ runs }: { runs: readonly Row[] }): null {
  useRunNotifications({
    runs,
    statusOf,
    labelOf,
    awaitingOf,
    shellsOpenOf,
    activeRunId: null,
  });
  return null;
}

describe('useRunNotifications', () => {
  let container: HTMLDivElement;
  let root: Root;
  const notify = vi.fn<GeniroApi['notify']>(async () => {});

  beforeEach(() => {
    vi.useFakeTimers();
    notify.mockClear();
    window.geniro = createPreloadStub({ notify });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  /** One reading of the one run under test. */
  const show = (status: RunStatusKind, shellsOpen: number): void => {
    act(() => root.render(<Probe runs={[{ id: 'r1', status, shellsOpen }]} />));
  };

  it('announces an ending with no command out at once', () => {
    show('running', 0);
    show('completed', 0);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('announces at once when the running command was launched long before the ending — a dev server left up', () => {
    show('running', 0);
    show('running', 1);
    // The CLOCK, not a timer: no banner here is ever waiting on one.
    vi.setSystemTime(Date.now() + RECENT_LAUNCH_MS + 1_000);
    show('completed', 1);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('announces at once when the commands were already out when the list loaded', () => {
    show('running', 1);
    show('completed', 1);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('skips an ending right after a launch, and announces the turn the command wakes instead', () => {
    show('running', 0);
    show('running', 1);
    show('completed', 1);
    // Nothing is pending that could post it later.
    vi.runAllTimers();
    expect(notify).not.toHaveBeenCalled();
    // The command reports, the CLI opens a turn of its own, and that one ends.
    show('completed', 0);
    show('running', 0);
    show('completed', 0);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('never skips a question', () => {
    show('running', 0);
    show('running', 1);
    show('needs-input', 1);
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
