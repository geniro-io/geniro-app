// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GeniroApi } from '../../shared/contracts';
import { createPreloadStub } from '../__fixtures__/preload-stub';
import type { RunStatusKind } from '../chats/run-status';
import {
  AFTER_CLOSE_GRACE_MS,
  HOLD_CEILING_MS,
  RECENT_LAUNCH_MS,
} from './run-notifications';
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

function Probe({
  runs,
  activeRunId,
}: {
  runs: readonly Row[];
  activeRunId: string | null;
}): null {
  useRunNotifications({
    runs,
    statusOf,
    labelOf,
    awaitingOf,
    shellsOpenOf,
    activeRunId,
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
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  /** One reading of the one run under test. */
  const show = (
    status: RunStatusKind,
    shellsOpen: number,
    activeRunId: string | null = null,
  ): void => {
    act(() =>
      root.render(
        <Probe
          runs={[{ id: 'r1', status, shellsOpen }]}
          activeRunId={activeRunId}
        />,
      ),
    );
  };

  const advance = (ms: number): void => {
    act(() => {
      vi.advanceTimersByTime(ms);
    });
  };

  it('announces an ending with no command out at once', () => {
    show('running', 0);
    show('completed', 0);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('announces at once when the running command was launched long before the ending — a dev server left up', () => {
    show('running', 0);
    show('running', 1);
    advance(RECENT_LAUNCH_MS + 1_000);
    show('completed', 1);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('announces at once when the commands were already out when the list loaded', () => {
    show('running', 1);
    show('completed', 1);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('holds an ending right after a launch, and drops it when the agent carries on', () => {
    show('running', 0);
    show('running', 1);
    show('completed', 1);
    expect(notify).not.toHaveBeenCalled();
    // The command reports, and the CLI opens a turn of its own.
    show('completed', 0);
    show('running', 0);
    advance(HOLD_CEILING_MS);
    expect(notify).not.toHaveBeenCalled();
  });

  it('announces a held ending once its command has ended and the agent stayed quiet', () => {
    show('running', 0);
    show('running', 1);
    show('completed', 1);
    show('completed', 0);
    advance(AFTER_CLOSE_GRACE_MS - 1);
    expect(notify).not.toHaveBeenCalled();
    advance(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('announces a held ending at the ceiling when its command never exits', () => {
    show('running', 0);
    show('running', 1);
    show('completed', 1);
    advance(HOLD_CEILING_MS - 1);
    expect(notify).not.toHaveBeenCalled();
    advance(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('never holds a question', () => {
    show('running', 0);
    show('running', 1);
    show('needs-input', 1);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('drops a held ending for a chat the user has since opened and is looking at', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    show('running', 0);
    show('running', 1);
    show('completed', 1);
    show('completed', 1, 'r1');
    advance(HOLD_CEILING_MS);
    expect(notify).not.toHaveBeenCalled();
  });
});
