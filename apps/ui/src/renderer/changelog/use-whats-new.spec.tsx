// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ChangelogRelease } from '../../shared/changelog';
import {
  type DaemonStatus,
  DEFAULT_SETTINGS,
  type Settings,
} from '../../shared/contracts';
import { createPreloadStub } from '../__fixtures__/preload-stub';
import { useWhatsNew } from './use-whats-new';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const CHANGELOG: ChangelogRelease[] = [
  {
    version: '1.3.0',
    date: '2026-03-01',
    sections: [{ kind: 'new', entries: [{ text: 'Third' }] }],
  },
  {
    version: '1.2.0',
    date: '2026-02-01',
    sections: [{ kind: 'internal', entries: [{ text: 'Only internal' }] }],
  },
  {
    version: '1.1.0',
    date: '2026-01-01',
    sections: [{ kind: 'fixed', entries: [{ text: 'First' }] }],
  },
];

const DAEMON: DaemonStatus = {
  connected: false,
  handle: null,
  migrating: null,
};

let container: HTMLDivElement;
let root: Root;
let writes: Partial<Settings>[];
let latest: ReturnType<typeof useWhatsNew> | null;

function Probe({ current }: { current: string | null }): null {
  latest = useWhatsNew(CHANGELOG, current);
  return null;
}

async function mount({
  current,
  lastSeen,
  isPackaged = true,
  onboardingComplete = true,
}: {
  current: string | null;
  lastSeen: string | null;
  isPackaged?: boolean;
  onboardingComplete?: boolean;
}): Promise<void> {
  window.geniro = createPreloadStub({
    getStatus: () =>
      Promise.resolve({ onboardingComplete, daemon: DAEMON, isPackaged }),
    getSettings: () =>
      Promise.resolve({
        ...DEFAULT_SETTINGS,
        lastSeenChangelogVersion: lastSeen,
      }),
    updateSettings: (patch) => {
      writes.push(patch);
      return Promise.resolve(DEFAULT_SETTINGS);
    },
  });
  await act(async () => {
    root.render(<Probe current={current} />);
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  writes = [];
  latest = null;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('useWhatsNew', () => {
  it('opens on the releases since the last seen one and records the running version only when dismissed', async () => {
    await mount({ current: '1.3.0', lastSeen: '1.1.0' });

    expect(latest?.releases.map((r) => r.version)).toEqual(['1.3.0']);
    expect(latest?.since).toBe('1.1.0');
    expect(writes).toEqual([]);

    await act(async () => latest?.dismiss());

    expect(latest?.releases).toEqual([]);
    expect(latest?.since).toBeNull();
    expect(writes).toEqual([{ lastSeenChangelogVersion: '1.3.0' }]);
  });

  it('records at once and opens nothing when the skipped releases hold only Internal changes', async () => {
    await mount({ current: '1.2.0', lastSeen: '1.1.0' });

    expect(latest?.releases).toEqual([]);
    expect(writes).toEqual([{ lastSeenChangelogVersion: '1.2.0' }]);
  });

  it('records silently on a fresh install that has not finished onboarding', async () => {
    await mount({
      current: '1.3.0',
      lastSeen: null,
      onboardingComplete: false,
    });

    expect(latest?.releases).toEqual([]);
    expect(writes).toEqual([{ lastSeenChangelogVersion: '1.3.0' }]);
  });

  it('neither opens nor writes in an unpackaged build', async () => {
    await mount({ current: '1.3.0', lastSeen: '1.1.0', isPackaged: false });

    expect(latest?.releases).toEqual([]);
    expect(writes).toEqual([]);
  });

  it('stays shut and writes nothing when the status read fails', async () => {
    window.geniro = createPreloadStub({
      getStatus: () => Promise.reject(new Error('bridge gone')),
      updateSettings: (patch) => {
        writes.push(patch);
        return Promise.resolve(DEFAULT_SETTINGS);
      },
    });
    await act(async () => {
      root.render(<Probe current="1.3.0" />);
    });

    expect(latest?.releases).toEqual([]);
    expect(writes).toEqual([]);
  });

  it('swallows a refused write of the version it records silently', async () => {
    window.geniro = createPreloadStub({
      getStatus: () =>
        Promise.resolve({
          onboardingComplete: false,
          daemon: DAEMON,
          isPackaged: true,
        }),
      updateSettings: (patch) => {
        writes.push(patch);
        return Promise.reject(new Error('refused'));
      },
    });
    await act(async () => {
      root.render(<Probe current="1.3.0" />);
    });

    expect(writes).toEqual([{ lastSeenChangelogVersion: '1.3.0' }]);
  });

  it('waits for the running version before deciding', async () => {
    await mount({ current: null, lastSeen: '1.1.0' });

    expect(latest?.releases).toEqual([]);
    expect(writes).toEqual([]);
  });
});
