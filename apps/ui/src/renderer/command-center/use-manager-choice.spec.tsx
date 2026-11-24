// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  type CliDetection,
  DEFAULT_SETTINGS,
  type ManagerConfig,
  type Settings,
} from '../../shared/contracts';
import { createPreloadStub } from '../__fixtures__/preload-stub';
import { useManagerChoice } from './use-manager-choice';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let writes: Partial<Settings>[];
let latest: ReturnType<typeof useManagerChoice> | null;

function Probe({
  cliDetections,
}: {
  cliDetections: readonly CliDetection[] | null;
}): null {
  latest = useManagerChoice(cliDetections);
  return null;
}

function detection(kind: string, found: boolean): CliDetection {
  return { kind, found } as unknown as CliDetection;
}

const ALL_FOUND = [
  detection('claude', true),
  detection('codex', true),
  detection('cursor-agent', true),
] as CliDetection[];

async function mount(
  cliDetections: readonly CliDetection[] | null,
  saved: ManagerConfig | null,
): Promise<void> {
  window.geniro = createPreloadStub({
    getSettings: () =>
      Promise.resolve({
        ...DEFAULT_SETTINGS,
        lastManagerConfig: saved,
      }),
    updateSettings: (patch) => {
      writes.push(patch);
      return Promise.resolve(DEFAULT_SETTINGS);
    },
  });
  await act(async () => {
    root.render(<Probe cliDetections={cliDetections} />);
  });
  await act(async () => undefined);
}

beforeEach(() => {
  writes = [];
  latest = null;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('useManagerChoice', () => {
  it('opens on the choice saved last, so a remount keeps the manager’s settings', async () => {
    const saved: ManagerConfig = {
      agent: 'codex',
      configDir: null,
      model: 'gpt-5.4',
      effort: 'high',
      contextWindow: '272k',
      modelParameters: { fast: 'on' },
      approval: 'auto',
      autoCompactPercent: 80,
    };

    await mount(ALL_FOUND, saved);

    expect(latest?.choice).toEqual(saved);
  });

  it('shows no choice until the saved one has been read', async () => {
    window.geniro = createPreloadStub({
      getSettings: () => new Promise<Settings>(() => {}),
    });
    await act(async () => {
      root.render(<Probe cliDetections={ALL_FOUND} />);
    });

    expect(latest?.choice).toBeNull();
  });

  it('falls back to a blank choice on the first CLI this machine has when the saved one is gone, keeping auto-compact and dropping the approval', async () => {
    await mount(
      [
        detection('claude', true),
        detection('codex', false),
        detection('cursor-agent', true),
      ] as CliDetection[],
      {
        agent: 'codex',
        configDir: null,
        model: 'gpt-5.4',
        effort: null,
        contextWindow: null,
        modelParameters: {},
        approval: 'auto',
        autoCompactPercent: 80,
      },
    );

    expect(latest?.choice).toEqual({
      agent: 'claude',
      configDir: null,
      model: null,
      effort: null,
      contextWindow: null,
      modelParameters: {},
      approval: null,
      autoCompactPercent: 80,
    });
  });

  it('saves every pick to settings at once and shows it', async () => {
    await mount(ALL_FOUND, null);
    const next: ManagerConfig = {
      agent: 'cursor-agent',
      configDir: null,
      model: 'auto',
      effort: null,
      contextWindow: null,
      modelParameters: {},
      approval: null,
      autoCompactPercent: null,
    };

    await act(async () => {
      latest?.pick(next);
    });

    expect(writes).toEqual([{ lastManagerConfig: next }]);
    expect(latest?.choice).toEqual(next);
  });
});
