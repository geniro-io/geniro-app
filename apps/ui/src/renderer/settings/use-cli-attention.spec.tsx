// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CliDetection, CliKind, CliUpdates } from '../../shared/contracts';
import { DETECTION_MAX_AGE_MS } from '../teams/use-sign-in-health';
import {
  type CliAttention,
  countCliSignInsNeeded,
  countCliUpdatesAvailable,
  signInsNeededText,
  useCliAttention,
} from './use-cli-attention';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function det(
  kind: CliKind,
  overrides: Partial<CliDetection> = {},
): CliDetection {
  return {
    kind,
    found: true,
    path: `/bin/${kind}`,
    version: '1.0.0',
    loggedIn: null,
    update: {
      available: null,
      latestVersion: null,
      checkUnavailableReason: null,
    },
    ...overrides,
  };
}

const updateAvailable = (): CliDetection['update'] => ({
  available: true,
  latestVersion: null,
  checkUnavailableReason: null,
});

describe('countCliUpdatesAvailable', () => {
  it('counts installed CLIs that said a newer version exists', () => {
    expect(
      countCliUpdatesAvailable([
        det('claude', { update: updateAvailable() }),
        det('codex'),
        det('cursor-agent', { found: false, update: updateAvailable() }),
      ]),
    ).toBe(1);
  });
});

describe('countCliSignInsNeeded', () => {
  it('counts a default profile the CLI said is signed out', () => {
    expect(countCliSignInsNeeded([det('claude', { loggedIn: false })])).toBe(1);
  });

  it('counts each named configuration the CLI said is signed out, once each', () => {
    expect(
      countCliSignInsNeeded([
        det('claude', {
          loggedIn: true,
          profileLogins: { '/a': false, '/b': false, '/c': true },
        }),
      ]),
    ).toBe(2);
  });

  it('adds a signed-out default profile to its signed-out configurations', () => {
    expect(
      countCliSignInsNeeded([
        det('claude', { loggedIn: false, profileLogins: { '/a': false } }),
      ]),
    ).toBe(2);
  });

  it('never counts an unknown answer, a signed-in account or a CLI with no answer', () => {
    expect(
      countCliSignInsNeeded([
        det('claude', { loggedIn: null, profileLogins: { '/a': null } }),
        det('cursor-agent', { loggedIn: true, profileLogins: { '/b': true } }),
        det('codex'),
      ]),
    ).toBe(0);
  });

  it('never counts a CLI that is not installed', () => {
    expect(
      countCliSignInsNeeded([
        det('claude', {
          found: false,
          loggedIn: false,
          profileLogins: { '/a': false },
        }),
      ]),
    ).toBe(0);
  });
});

describe('signInsNeededText', () => {
  it('says how many accounts need sign-in, in the singular for one', () => {
    expect(signInsNeededText(1)).toBe('1 account needs sign-in');
    expect(signInsNeededText(2)).toBe('2 accounts need sign-in');
  });
});

let container: HTMLDivElement;
let root: Root;
let push: (state: CliUpdates) => void;
let detectClis: ReturnType<typeof vi.fn>;
let attention: CliAttention;

function Probe(): React.JSX.Element {
  attention = useCliAttention();
  return (
    <>
      <output data-slot="updates">{attention.updatesAvailable}</output>
      <output data-slot="sign-ins">{attention.signInsNeeded}</output>
    </>
  );
}

const shown = (slot: 'updates' | 'sign-ins'): string | null =>
  container.querySelector(`[data-slot="${slot}"]`)?.textContent ?? null;

beforeEach(() => {
  detectClis = vi.fn();
  Object.assign(window, {
    geniro: {
      detectClis,
      getCliUpdates: () => Promise.resolve({ updating: [], results: {} }),
      onCliUpdates: (listener: (state: CliUpdates) => void) => {
        push = listener;
        return () => undefined;
      },
    },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('useCliAttention', () => {
  it('hands a reading one hook took to every other hook in the window, newest first', async () => {
    let elsewhere: CliAttention | null = null;
    function Elsewhere(): null {
      elsewhere = useCliAttention();
      return null;
    }
    detectClis.mockResolvedValue([det('claude', { loggedIn: false })]);
    await act(async () => {
      root.render(
        <>
          <Probe />
          <Elsewhere />
        </>,
      );
    });
    expect(shown('sign-ins')).toBe('1');

    detectClis.mockResolvedValue([det('claude', { loggedIn: true })]);
    await act(async () => {
      elsewhere!.refresh(true);
    });

    expect(shown('sign-ins')).toBe('0');
  });

  it('counts the updates waiting from a cached detection', async () => {
    detectClis.mockResolvedValue([
      det('claude', { update: updateAvailable() }),
      det('codex'),
      det('cursor-agent', { found: false, update: updateAvailable() }),
    ]);

    await act(async () => {
      root.render(<Probe />);
    });

    expect(shown('updates')).toBe('1');
    expect(detectClis).toHaveBeenCalledWith({ maxAgeMs: DETECTION_MAX_AGE_MS });
  });

  it('counts the accounts that need sign-in from the same cached detection', async () => {
    detectClis.mockResolvedValue([
      det('claude', { loggedIn: false }),
      det('cursor-agent', { loggedIn: true, profileLogins: { '/b': false } }),
    ]);

    await act(async () => {
      root.render(<Probe />);
    });

    expect(shown('sign-ins')).toBe('2');
    expect(detectClis).toHaveBeenCalledTimes(1);
  });

  it('shows a detection handed over with adopt at once, without a focus event', async () => {
    detectClis.mockResolvedValue([]);
    await act(async () => {
      root.render(<Probe />);
    });
    expect(shown('sign-ins')).toBe('0');

    await act(async () => {
      attention.adopt([det('claude', { loggedIn: false })]);
    });

    expect(shown('sign-ins')).toBe('1');
    expect(detectClis).toHaveBeenCalledTimes(1);
  });

  it('keeps an adopted detection when a read started before it lands late', async () => {
    let answerRead: (detections: CliDetection[]) => void = () => undefined;
    detectClis.mockReturnValueOnce(
      new Promise<CliDetection[]>((resolve) => {
        answerRead = resolve;
      }),
    );
    await act(async () => {
      root.render(<Probe />);
    });

    await act(async () => {
      attention.adopt([det('claude', { loggedIn: false })]);
    });
    await act(async () => {
      answerRead([det('claude', { loggedIn: true })]);
    });

    expect(shown('sign-ins')).toBe('1');
  });

  it('re-reads on window focus', async () => {
    detectClis.mockResolvedValueOnce([det('claude', { loggedIn: null })]);
    await act(async () => {
      root.render(<Probe />);
    });
    expect(shown('sign-ins')).toBe('0');

    detectClis.mockResolvedValue([det('claude', { loggedIn: false })]);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });

    expect(shown('sign-ins')).toBe('1');
  });

  it('reads the CLIs afresh once an update ends, so the badge drops the CLI just updated', async () => {
    detectClis.mockResolvedValueOnce([
      det('claude', { update: updateAvailable() }),
    ]);
    await act(async () => {
      root.render(<Probe />);
    });
    detectClis.mockResolvedValue([det('claude')]);

    await act(async () => {
      push({ updating: ['claude'], results: {} });
    });
    expect(detectClis).toHaveBeenCalledTimes(1);
    await act(async () => {
      push({ updating: [], results: {} });
    });

    expect(detectClis).toHaveBeenLastCalledWith(undefined);
    expect(shown('updates')).toBe('0');
  });

  it('hands over the detections themselves, null until the first reading lands', async () => {
    let answer: (detections: CliDetection[]) => void = () => undefined;
    detectClis.mockReturnValueOnce(
      new Promise<CliDetection[]>((resolve) => {
        answer = resolve;
      }),
    );
    await act(async () => {
      root.render(<Probe />);
    });
    expect(attention.detections).toBeNull();

    const read = [det('claude', { loggedIn: false })];
    await act(async () => {
      answer(read);
    });

    expect(attention.detections).toEqual(read);
  });

  it('probes the CLIs afresh on refresh(true) and asks the cache on refresh(false)', async () => {
    detectClis.mockResolvedValue([]);
    await act(async () => {
      root.render(<Probe />);
    });
    detectClis.mockResolvedValue([det('claude', { loggedIn: false })]);

    await act(async () => {
      attention.refresh(true);
    });
    expect(detectClis).toHaveBeenLastCalledWith(undefined);
    expect(shown('sign-ins')).toBe('1');

    await act(async () => {
      attention.refresh(false);
    });
    expect(detectClis).toHaveBeenLastCalledWith({
      maxAgeMs: DETECTION_MAX_AGE_MS,
    });
  });
});
