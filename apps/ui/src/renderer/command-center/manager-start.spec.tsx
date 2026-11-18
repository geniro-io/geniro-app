// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type CliDetection,
  DEFAULT_SETTINGS,
  type MemoryTriageConfig,
} from '../../shared/contracts';
import { createPreloadStub } from '../__fixtures__/preload-stub';
import type { DaemonApis } from '../daemon-api';
import { ManagerStart } from './manager-start';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const DETECTIONS = [
  { kind: 'claude', found: true },
  { kind: 'codex', found: true },
  { kind: 'cursor-agent', found: false },
] as unknown as CliDetection[];

const CHOICE: MemoryTriageConfig = {
  agent: 'codex',
  configDir: '/Users/me/codex-work',
  model: 'gpt-5.4',
  effort: 'high',
  contextWindow: '272k',
  modelParameters: { fast: 'on' },
};

function settle(): Promise<void> {
  return act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function picker(label: string): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  );
}

async function click(target: HTMLElement): Promise<void> {
  await act(async () => {
    target.click();
  });
  await settle();
}

function button(text: string): HTMLButtonElement {
  return [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent?.trim() === text,
  )!;
}

function renderStart(
  choice: MemoryTriageConfig,
  onPick: (next: MemoryTriageConfig) => void,
  onOpened: () => void,
  openCommandCenterChat: ReturnType<typeof vi.fn>,
): Promise<void> {
  const apis = {
    agents: null,
    commandCenter: { openCommandCenterChat },
  } as unknown as DaemonApis;
  return act(async () => {
    root.render(
      <ManagerStart
        apis={apis}
        choice={choice}
        onPick={onPick}
        cliDetections={DETECTIONS}
        capabilities={null}
        capabilitiesLoading={false}
        recentConfigDirs={{}}
        configProfiles={[]}
        onOpened={onOpened}
      />,
    );
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  window.geniro = createPreloadStub({
    getSettings: () =>
      Promise.resolve({
        ...DEFAULT_SETTINGS,
        customInstructions: 'Be brief.',
        replyLanguage: 'Russian',
      }),
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('ManagerStart', () => {
  it('offers the agent picker and the full model settings menu, not a bare select', async () => {
    await renderStart(CHOICE, vi.fn(), vi.fn(), vi.fn());

    expect(picker('Manager agent')).not.toBeNull();
    expect(picker('Model and its settings')).not.toBeNull();
  });

  it('starts the manager with the picked agent, profile, model, effort, window and parameters', async () => {
    const openCommandCenterChat = vi.fn(async () => ({}));
    const onOpened = vi.fn();
    await renderStart(CHOICE, vi.fn(), onOpened, openCommandCenterChat);

    await click(button('Open the manager'));

    expect(openCommandCenterChat).toHaveBeenCalledTimes(1);
    expect(openCommandCenterChat).toHaveBeenCalledWith({
      startCommandCenterChatDto: {
        agentKind: 'codex',
        configDir: '/Users/me/codex-work',
        model: 'gpt-5.4',
        effort: 'high',
        contextWindow: '272k',
        modelParameters: { fast: 'on' },
        customInstructions: 'Be brief.',
        replyLanguage: 'Russian',
        agentOptions: {},
      },
    });
    expect(onOpened).toHaveBeenCalledTimes(1);
  });

  it('picking another CLI starts that CLI’s settings blank', async () => {
    const onPick = vi.fn();
    await renderStart(CHOICE, onPick, vi.fn(), vi.fn());

    await click(picker('Manager agent')!);
    await click(
      document.querySelector<HTMLElement>('[role="option"][title="claude"]')!,
    );

    expect(onPick).toHaveBeenCalledWith({
      agent: 'claude',
      configDir: null,
      model: null,
      effort: null,
      contextWindow: null,
      modelParameters: {},
    });
  });
});
