// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GeniroApi } from '../../shared/contracts';
import { createPreloadStub } from '../__fixtures__/preload-stub';
import type { RunStatusKind } from '../chats/run-status';
import type { AgentNotice } from './run-notifications';
import { useRunNotifications } from './use-run-notifications';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

interface Row {
  id: string;
  status: RunStatusKind;
  shellsOpen: number;
}

// Module scope, so the hook's effects re-run on the run list alone — the way
// `Chats` hands it memoized readers.
const statusOf = (run: Row): RunStatusKind => run.status;
const labelOf = (run: Row): string => run.id;
const awaitingOf = (): null => null;
const shellsOpenOf = (run: Row): number => run.shellsOpen;

function Probe({
  runs,
  notices,
}: {
  runs: readonly Row[];
  notices: readonly AgentNotice[];
}): null {
  useRunNotifications({
    runs,
    statusOf,
    labelOf,
    awaitingOf,
    shellsOpenOf,
    notices,
    activeRunId: null,
  });
  return null;
}

describe('useRunNotifications', () => {
  let container: HTMLDivElement;
  let root: Root;
  let notices: AgentNotice[];
  const notify = vi.fn<GeniroApi['notify']>(async () => {});
  const retractNotification = vi.fn<GeniroApi['retractNotification']>(
    async () => {},
  );

  beforeEach(() => {
    notify.mockClear();
    retractNotification.mockClear();
    notices = [];
    window.geniro = createPreloadStub({ notify, retractNotification });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  /** One reading of the one run under test. */
  const show = (status: RunStatusKind, shellsOpen = 0): void => {
    act(() =>
      root.render(
        <Probe
          runs={[{ id: 'r1', status, shellsOpen }]}
          notices={[...notices]}
        />,
      ),
    );
  };

  /** The agent's `notify_user` call arriving, with the run as it stands. */
  const agentSays = (
    message: string,
    status: RunStatusKind,
    shellsOpen = 0,
  ): void => {
    notices.push({ id: notices.length + 1, runId: 'r1', message });
    show(status, shellsOpen);
  };

  it('announces a finished turn with nothing left running', () => {
    show('running');
    show('completed');
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('announces a finished turn with a command still running, as a banner it can take back', () => {
    // The reported case: the agent finished and left a dev server up.
    show('running', 1);
    show('completed', 1);
    expect(notify).toHaveBeenCalledWith({
      kind: 'turn-end',
      runId: 'r1',
      title: 'r1',
      body: 'The turn finished — 1 command still running.',
      retractable: true,
    });
    expect(retractNotification).not.toHaveBeenCalled();
  });

  it('withdraws that banner when the run goes back to work — the agent was only waiting', () => {
    show('running', 1);
    show('completed', 1);
    // The command reported back and the CLI opened a turn of its own.
    show('running', 0);
    expect(retractNotification).toHaveBeenCalledWith('r1');

    // That continuation's ending is the real one, and it is final.
    show('completed', 0);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[1]![0]).not.toHaveProperty('retractable');
  });

  it('leaves the banner standing while nothing reopens the run', () => {
    show('running', 1);
    show('completed', 1);
    show('completed', 1);
    show('completed', 0);
    expect(retractNotification).not.toHaveBeenCalled();
  });

  it('never withdraws a final banner', () => {
    show('running');
    show('completed');
    show('running');
    show('completed');
    expect(retractNotification).not.toHaveBeenCalled();
  });

  it('still announces a FAILED turn while a command is running — nobody asked for it', () => {
    show('running', 1);
    show('failed', 1);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("posts the agent's own notification, in its words", () => {
    show('running', 1);
    agentSays(
      'The dev server is running at http://localhost:3000.',
      'running',
      1,
    );
    expect(notify).toHaveBeenCalledWith({
      kind: 'turn-end',
      runId: 'r1',
      title: 'r1',
      body: 'The dev server is running at http://localhost:3000.',
    });
  });

  it('posts each notice once, however often the list re-renders', () => {
    show('running', 1);
    agentSays('Ready to try.', 'running', 1);
    show('running', 1);
    show('running', 1);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('does not announce the ending of a turn whose agent already notified', () => {
    show('running');
    agentSays('All done — the build is green.', 'running');
    show('completed');
    // The one banner is the agent's own — not the turn's plain ending.
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'All done — the build is green.' }),
    );
  });

  it("announces the NEXT turn's ending as usual after a notice", () => {
    show('running');
    agentSays('Ready.', 'running');
    show('completed');
    show('running');
    show('completed');
    expect(notify.mock.calls.map(([payload]) => payload.body)).toEqual([
      'Ready.',
      'The turn finished.',
    ]);
  });

  it('never skips a question', () => {
    show('running', 1);
    show('needs-input', 1);
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
