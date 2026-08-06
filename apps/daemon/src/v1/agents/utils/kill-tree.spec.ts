import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createGroupTerminator, GROUP_KILL_GRACE_MS } from './kill-tree';

/**
 * A child whose `pid` doubles as its process-group id, plus the direct-kill
 * signals it received — so a spec can tell a group signal from the fallback.
 */
function fakeChild(pid: number | null = 4242): {
  child: { pid?: number; kill(signal?: NodeJS.Signals): boolean };
  directKills: NodeJS.Signals[];
} {
  const directKills: NodeJS.Signals[] = [];
  return {
    child: {
      // `null` means "no pid at all" — an explicit `undefined` argument would
      // silently take the default above and test the group path by accident.
      ...(pid === null ? {} : { pid }),
      kill: (signal?: NodeJS.Signals) => {
        directKills.push(signal ?? 'SIGTERM');
        return true;
      },
    },
    directKills,
  };
}

describe('createGroupTerminator', () => {
  let kill: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    // Never let a spec signal a real process group.
    kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** The group signals, in order, that the terminator sent to `-pid`. */
  const groupSignals = (): NodeJS.Signals[] =>
    (kill.mock.calls as [number, NodeJS.Signals][])
      .filter(([pid]) => pid === -4242)
      .map(([, signal]) => signal);

  it('asks the group to stop before it forces it', () => {
    createGroupTerminator(fakeChild().child).terminate();

    // The whole point of the escalation: the user's own MCP servers get a
    // SIGTERM to shut down cleanly. A straight SIGKILL fails here.
    expect(groupSignals()).toEqual(['SIGTERM']);
  });

  it('escalates to SIGKILL once the grace has elapsed', () => {
    createGroupTerminator(fakeChild().child).terminate();

    vi.advanceTimersByTime(GROUP_KILL_GRACE_MS - 1);
    expect(groupSignals()).toEqual(['SIGTERM']);

    vi.advanceTimersByTime(1);
    expect(groupSignals()).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('does not force-kill a group whose process is already accounted for', () => {
    let gone = false;
    const terminator = createGroupTerminator(fakeChild().child, {
      isGone: () => gone,
    });
    terminator.terminate();
    gone = true;

    vi.advanceTimersByTime(GROUP_KILL_GRACE_MS);

    // Signalling here would name a pid the OS may since have reissued.
    expect(groupSignals()).toEqual(['SIGTERM']);
  });

  it('cancels a pending escalation when disarmed', () => {
    const terminator = createGroupTerminator(fakeChild().child);
    terminator.terminate();
    terminator.disarm();

    vi.advanceTimersByTime(GROUP_KILL_GRACE_MS);

    expect(groupSignals()).toEqual(['SIGTERM']);
  });

  it('arms the escalation once however many times it is asked to terminate', () => {
    const terminator = createGroupTerminator(fakeChild().child);
    terminator.terminate();
    terminator.terminate();
    terminator.terminate();

    vi.advanceTimersByTime(GROUP_KILL_GRACE_MS);

    expect(groupSignals()).toEqual([
      'SIGTERM',
      'SIGTERM',
      'SIGTERM',
      'SIGKILL',
    ]);
  });

  it('falls back to a direct kill when there is no pid to name a group with', () => {
    const { child, directKills } = fakeChild(null);
    createGroupTerminator(child).terminate();
    vi.advanceTimersByTime(GROUP_KILL_GRACE_MS);

    expect(kill).not.toHaveBeenCalled();
    expect(directKills).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('falls back to a direct kill when the group is already gone', () => {
    const { child, directKills } = fakeChild();
    kill.mockImplementation(() => {
      throw new Error('ESRCH');
    });

    createGroupTerminator(child).terminate();

    expect(directKills).toEqual(['SIGTERM']);
  });
});
