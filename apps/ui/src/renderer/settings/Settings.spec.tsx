// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  CliDetection,
  CliKind,
  Settings as SettingsShape,
  UpdateState,
} from '../../shared/contracts';
import {
  DAEMON_INSPECT_PORT,
  DEFAULT_SETTINGS,
  MAX_CUSTOM_INSTRUCTIONS_CHARS,
} from '../../shared/contracts';
import { THEMES } from '../../shared/themes';
import { createPreloadStub } from '../__fixtures__/preload-stub';
import { Settings, type SettingsSection } from './Settings';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// Spread the real defaults so a new Settings field is not a spec edit; only
// the fields this spec actually asserts on are named.
const settings: SettingsShape = {
  ...DEFAULT_SETTINGS,
  onboardingComplete: true,
  projectFolder: '/proj',
  checkForUpdates: false,
};

const geniro = {
  getStatus: vi.fn(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  detectClis: vi.fn(),
  pickAgentBinary: vi.fn(),
  getUpdateState: vi.fn(),
  checkForUpdates: vi.fn(),
  installUpdate: vi.fn(),
  onUpdateState: vi.fn().mockReturnValue(() => {}),
  openInTerminal: vi.fn(),
  notify: vi.fn(),
  testNotification: vi.fn(),
  openNotificationSettings: vi.fn(),
  onNotificationActivated: vi.fn().mockReturnValue(() => {}),
};

// The daemon client is mocked so Settings never issues a real fetch —
// `createDaemonApis` hands back one object per launch handle, so a single factory
// mock covers every client on it.
const cliAuthApi = vi.hoisted(() => ({
  cliLogout: vi.fn(),
  startCliLogin: vi.fn(),
  getCliLogin: vi.fn(),
  submitCliLoginCode: vi.fn(),
  cancelCliLogin: vi.fn(),
}));
// `capabilities` is read by `useConfigDirCapability` for the account row's
// profile qualifier; rejecting is the honest "not answered" and leaves the row
// unqualified, which is what these specs assert against.
const capabilitiesApi = vi.hoisted(() => ({
  getCapabilities: vi.fn(() => Promise.reject(new Error('not in this spec'))),
}));
const chatsApi = vi.hoisted(() => ({
  forgetCustomInstructions: vi.fn(() => Promise.resolve({ cleared: 0 })),
}));
// Listed by the graphs screen, not by this one — kept because
// `createDaemonApis` is mocked whole and every key it returns must exist.
const workflowsApi = vi.hoisted(() => ({
  listWorkflows: vi.fn(() => Promise.resolve([])),
}));
vi.mock('../daemon-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../daemon-api')>()),
  createDaemonApis: vi.fn(() => ({
    cliAuth: cliAuthApi,
    capabilities: capabilitiesApi,
    chats: chatsApi,
    workflows: workflowsApi,
  })),
}));

const handle = {
  host: '127.0.0.1',
  port: 8123,
  token: 'tok',
  version: '1',
  startedAt: '2026-01-01T00:00:00.000Z',
};

/** An update state as main would push it; `idle` unless a phase is named. */
function updateState(overrides: Partial<UpdateState> = {}): UpdateState {
  return {
    phase: 'idle',
    version: null,
    progress: null,
    message: null,
    currentVersion: '0.1.0',
    canInstall: true,
    failedPhase: null,
    ...overrides,
  };
}

function det(
  kind: CliKind,
  overrides: Partial<CliDetection> = {},
): CliDetection {
  return {
    kind,
    found: true,
    path: `/bin/${kind}`,
    version: '1.2.3',
    loggedIn: null,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root | null;

async function mount(section?: SettingsSection): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  const mountedRoot = createRoot(container);
  root = mountedRoot;
  await act(async () => {
    mountedRoot.render(<Settings handle={handle} section={section} />);
  });
}

beforeEach(() => {
  // Packaged FALSE is the dev answer, and it is what makes the inspector's
  // unchosen state resolve to on — the specs below assert on that.
  geniro.getStatus.mockReset().mockResolvedValue({
    onboardingComplete: true,
    daemon: { connected: true, handle: null },
    isPackaged: false,
  });
  geniro.getSettings.mockReset().mockResolvedValue(settings);
  geniro.updateSettings.mockReset().mockResolvedValue(settings);
  geniro.detectClis.mockReset().mockResolvedValue([]);
  geniro.openInTerminal.mockReset().mockResolvedValue(undefined);
  geniro.getUpdateState.mockReset().mockResolvedValue(updateState());
  geniro.checkForUpdates
    .mockReset()
    .mockResolvedValue(updateState({ phase: 'up-to-date' }));
  geniro.installUpdate.mockReset();
  geniro.onUpdateState.mockReset().mockReturnValue(() => {});
  geniro.testNotification
    .mockReset()
    .mockResolvedValue({ posted: true, shown: true, reason: null });
  geniro.openNotificationSettings.mockReset().mockResolvedValue(undefined);
  cliAuthApi.cliLogout.mockReset().mockResolvedValue({
    agent: 'cursor-agent',
    ok: true,
    unavailableReason: null,
  });
  cliAuthApi.startCliLogin.mockReset();
  cliAuthApi.getCliLogin.mockReset();
  cliAuthApi.submitCliLoginCode.mockReset();
  cliAuthApi.cancelCliLogin.mockReset();
  window.geniro = createPreloadStub(geniro);
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
  }
  container.remove();
});

describe('Settings notifications section', () => {
  /** The section holding the notifications switch. */
  function notificationsSection(): HTMLElement {
    return container
      .querySelector('#settings-notifications')!
      .closest('section')!;
  }

  function buttonNamed(text: string): HTMLButtonElement | undefined {
    return [...notificationsSection().querySelectorAll('button')].find(
      (button) => button.textContent?.includes(text),
    );
  }

  it('scrolls the PANE, not the reading column', async () => {
    // REPORTED as "scroll should be for all page, not just in the middle". One
    // element was both the centred 42rem column and the scroll container, so
    // the scrollbar was drawn at the column's edge with dead page background
    // either side — measured in a 1200px window, its right edge sat at x=1025,
    // 175px short of where every other scrollbar on the machine lives.
    //
    // Structural, not geometric: jsdom computes no layout, so the position is
    // unobservable here — but "which element scrolls, and is it the one that
    // caps the width" is exactly the DOM fact that decides the position, and it
    // is the fact that regressed.
    await mount();

    const scroller = container.querySelector('.overflow-y-auto');
    expect(scroller).not.toBeNull();
    expect(scroller!.className).not.toMatch(/\bmax-w-/);
    expect(scroller!.className).not.toMatch(/\bmx-auto\b/);
    // …and the column it scrolls is INSIDE it, still centred and still capped.
    const column = scroller!.querySelector('.mx-auto');
    expect(column?.className).toMatch(/\bmax-w-/);
  });

  it('opens macOS’s own Notifications pane on one press', async () => {
    // The report: the app already KNEW where to send the user ("System Settings
    // › Notifications › Geniro") and printed it as directions to follow by
    // hand. A destination the app can reach is a button, not a sentence.
    await mount();

    await act(async () => {
      buttonNamed('macOS settings')?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });

    expect(geniro.openNotificationSettings).toHaveBeenCalledTimes(1);
    // No argument: the destination is a constant in main, so the renderer
    // cannot aim `shell.openExternal` at a pane of its choosing.
    expect(geniro.openNotificationSettings).toHaveBeenCalledWith();
  });

  it('offers the way out WITHOUT having to run the test first', async () => {
    // The button that only appears once a test has failed is no use to the
    // user who already knows the banners are missing — which is how the report
    // arrived, after the test had been run and read.
    await mount();

    expect(buttonNamed('macOS settings')).toBeDefined();
    expect(notificationsSection().textContent).not.toContain('Sent —');
  });

  it('points a shown-but-unseen test at that button rather than at a path to walk', async () => {
    await mount();

    await act(async () => {
      buttonNamed('Send a test')?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });

    const result = container.querySelector(
      '[data-slot="notification-test-result"]',
    );
    expect(result?.textContent).toContain('open macOS settings above');
    expect(result?.textContent).not.toContain(
      'System Settings › Notifications',
    );
  });
});

/**
 * Expand one agent's card — every agent-specific setting now lives inside one,
 * so a test that does not open it finds nothing.
 *
 * By the header's own TEXT rather than by position: the list is ordered by
 * `CLI_KINDS`, and an index would silently retarget onto the other agent the
 * day a third is added.
 */
async function openAgentCard(kind: string): Promise<void> {
  const header = [
    ...container.querySelectorAll<HTMLButtonElement>('button[aria-expanded]'),
  ].find((button) => button.textContent?.includes(kind));
  if (!header) {
    throw new Error(`no card header for ${kind}`);
  }
  await act(async () => {
    header.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('Settings updates section', () => {
  it('seeds the update toggle from persisted settings', async () => {
    await mount();

    const toggle = container.querySelector('#settings-check-updates');
    expect(toggle?.getAttribute('aria-checked')).toBe('false');
  });

  it('names the toggle through a real associated label, not a duplicate button', async () => {
    await mount();

    const toggle = container.querySelector('#settings-check-updates')!;
    const label = container.querySelector<HTMLLabelElement>(
      `label[for="${toggle.id}"]`,
    );
    expect(toggle.getAttribute('role')).toBe('switch');
    expect(label?.textContent).toBe('Check for updates automatically');
    // Exactly one switch IN THIS SECTION: the old raw-button label doubled the
    // toggle surface with no state semantics for assistive tech. Scoped to the
    // section rather than the page, because unrelated settings legitimately
    // add their own switches — a page-wide count would fail on the next one
    // instead of on the duplication it exists to catch.
    expect(
      toggle.closest('section')?.querySelectorAll('[role="switch"]'),
    ).toHaveLength(1);
  });

  it('does not overwrite a user toggle when the initial settings read resolves late', async () => {
    let resolveSettings!: (value: SettingsShape) => void;
    geniro.getSettings.mockReturnValueOnce(
      new Promise<SettingsShape>((resolve) => {
        resolveSettings = resolve;
      }),
    );
    await mount();
    // BY ID, not "the first switch on the page": the page legitimately grows
    // switches in other sections, and a positional selector silently retargets
    // these assertions onto whichever one happens to render first.
    const toggle = container.querySelector<HTMLButtonElement>(
      '#settings-check-updates',
    )!;

    await act(async () => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(toggle.getAttribute('aria-checked')).toBe('false');

    await act(async () => {
      resolveSettings({ ...settings, checkForUpdates: true });
      await Promise.resolve();
    });

    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });

  it('auto-saves the update toggle on flip — no Save button', async () => {
    await mount();
    // The Save button is gone; flipping the switch must persist on its own.
    expect(
      [...container.querySelectorAll('button')].some((b) =>
        b.textContent?.includes('Save changes'),
      ),
    ).toBe(false);

    // BY ID, not "the first switch on the page": the page legitimately grows
    // switches in other sections, and a positional selector silently retargets
    // these assertions onto whichever one happens to render first.
    const toggle = container.querySelector<HTMLButtonElement>(
      '#settings-check-updates',
    )!;
    await act(async () => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(geniro.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ checkForUpdates: true }),
    );
    // The switch reflects the new state immediately.
    expect(toggle.getAttribute('aria-checked')).toBe('true');
  });

  it('keeps an agent-specific setting INSIDE that agent’s card', async () => {
    // REPORTED as "все специфические, именно к агентам специфичные настройки
    // должны быть там": Max Mode and claude's browser tools each had a page
    // section of their own, so what a reader could change about cursor was
    // half in the card named cursor and half two screens below under a heading
    // that named a topic. Neither is reachable now without opening the card
    // it belongs to — which is the fix, and is why every case below has to
    // open one first.
    await mount();

    expect(container.querySelector('#settings-cursor-max-mode')).toBeNull();
    expect(
      container.querySelector('#settings-claude-browser-tools'),
    ).toBeNull();

    await openAgentCard('cursor-agent');
    const maxMode = container.querySelector('#settings-cursor-max-mode');
    expect(maxMode).not.toBeNull();
    // In the CARD, not merely on the page: a section would satisfy a bare
    // presence check just as well, which is what was there before.
    expect(maxMode?.closest('[data-slot="card"]')).not.toBeNull();
    // And it is the cursor card — the claude one is still shut.
    expect(
      container.querySelector('#settings-claude-browser-tools'),
    ).toBeNull();
  });

  it('turns Max Mode OFF and persists the decline as such', async () => {
    // The switch exists because Max Mode is not free on every plan: Cursor
    // bills it at the model's API rate plus 20% on legacy request-based ones,
    // and which plan a user is on is not something this app can read. It
    // defaults ON — the defect that produced it was a window too SMALL — so
    // the case worth pinning is turning it OFF, which has to persist as an
    // explicit `false` rather than as an absent key.
    await mount();
    await openAgentCard('cursor-agent');

    const toggle = container.querySelector<HTMLButtonElement>(
      '#settings-cursor-max-mode',
    )!;
    expect(toggle).not.toBeNull();
    expect(toggle.getAttribute('aria-checked')).toBe('true');

    await act(async () => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(geniro.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ cursorMaxMode: false }),
    );
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });

  it('ignores an older toggle write failure after the latest write succeeds', async () => {
    let rejectFirst!: (reason: unknown) => void;
    let resolveSecond!: (value: SettingsShape) => void;
    geniro.updateSettings
      .mockReturnValueOnce(
        new Promise<SettingsShape>((_resolve, reject) => {
          rejectFirst = reject;
        }),
      )
      .mockReturnValueOnce(
        new Promise<SettingsShape>((resolve) => {
          resolveSecond = resolve;
        }),
      );
    await mount();
    // BY ID, not "the first switch on the page": the page legitimately grows
    // switches in other sections, and a positional selector silently retargets
    // these assertions onto whichever one happens to render first.
    const toggle = container.querySelector<HTMLButtonElement>(
      '#settings-check-updates',
    )!;

    await act(async () => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      resolveSecond(settings);
      await Promise.resolve();
      rejectFirst(new Error('older write failed'));
      await Promise.resolve();
    });

    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(container.textContent).not.toContain('older write failed');
  });

  it('runs a manual update check and reports the outcome', async () => {
    await mount();
    const check = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Check now'),
    )!;

    await act(async () => {
      check.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(geniro.checkForUpdates).toHaveBeenCalled();
    expect(container.textContent).toContain('Up to date (v0.1.0)');
  });

  it('offers an Update now button once a newer release is found, and installs on press', async () => {
    geniro.checkForUpdates.mockResolvedValueOnce(
      updateState({ phase: 'available', version: '0.2.0' }),
    );
    geniro.installUpdate.mockResolvedValue(
      updateState({ phase: 'downloading', version: '0.2.0', progress: 0 }),
    );
    await mount();
    const check = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Check now'),
    )!;

    await act(async () => {
      check.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.textContent).toContain('Geniro 0.2.0 is available');

    const install = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Update now'),
    )!;
    expect(install).toBeTruthy();
    await act(async () => {
      install.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(geniro.installUpdate).toHaveBeenCalled();
    // The screen follows the install rather than sitting on the offer it just
    // acted on — the state it renders is main's, not a local flag.
    expect(container.textContent).toContain('Downloading Geniro 0.2.0');
    expect(container.querySelector('[role="progressbar"]')).toBeTruthy();
  });

  it('names an available update this copy cannot install, instead of a dead button', async () => {
    geniro.checkForUpdates.mockResolvedValueOnce(
      updateState({
        phase: 'available',
        version: '0.2.0',
        canInstall: false,
        message: 'Update with: brew upgrade --cask geniro',
      }),
    );
    await mount();
    const check = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Check now'),
    )!;

    await act(async () => {
      check.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).toContain('brew upgrade --cask geniro');
    expect(
      [...container.querySelectorAll('button')].some((b) =>
        b.textContent?.includes('Update now'),
      ),
    ).toBe(false);
  });

  it('surfaces a broken channel rather than a button that visibly does nothing', async () => {
    geniro.checkForUpdates.mockRejectedValueOnce(new Error('ipc broke'));
    await mount();
    const check = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Check now'),
    )!;

    await act(async () => {
      check.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).toContain('ipc broke');
  });

  it('flushes a pending CLI path edit when Settings unmounts', async () => {
    await mount();
    const claudeToggle = [...container.querySelectorAll('button')].find(
      (button) => button.textContent?.includes('claude'),
    )!;
    await act(async () => {
      claudeToggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const input =
      container.querySelector<HTMLInputElement>('#agent-path-claude')!;
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    await act(async () => {
      setValue?.call(input, '  /opt/new-claude  ');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(geniro.updateSettings).not.toHaveBeenCalled();
    await act(async () => root?.unmount());
    root = null;

    expect(geniro.updateSettings).toHaveBeenCalledWith({
      cliPaths: { claude: '/opt/new-claude' },
    });
  });
});

describe('Settings — custom instructions', () => {
  beforeEach(() => {
    // Back to the file-wide default (a rejecting read). Without this the one
    // case below that resolves capabilities leaks its answer into the case
    // that asserts on NOT having one, and the two pass or fail by order.
    capabilitiesApi.getCapabilities
      .mockReset()
      .mockRejectedValue(new Error('not in this spec'));
    // Reset too, or the purge cases leak their call counts into the one that
    // asserts the purge is NOT reached by clearing the box.
    chatsApi.forgetCustomInstructions
      .mockReset()
      .mockResolvedValue({ cleared: 0 });
  });

  /** Type into the instructions box the way a user does. */
  async function typeInstructions(text: string): Promise<void> {
    const box = container.querySelector<HTMLTextAreaElement>(
      '#settings-custom-instructions',
    )!;
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )?.set;
    await act(async () => {
      setValue?.call(box, text);
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  it('seeds the box from persisted settings', async () => {
    geniro.getSettings.mockResolvedValue({
      ...settings,
      customInstructions: 'Always answer in British English.',
    });
    await mount();

    expect(
      container.querySelector<HTMLTextAreaElement>(
        '#settings-custom-instructions',
      )?.value,
    ).toBe('Always answer in British English.');
  });

  it('survives a settings payload with no customInstructions key at all', async () => {
    // Found by driving the real renderer bundle, not by this file: every other
    // case here spreads DEFAULT_SETTINGS, so the key is always present and the
    // crash was invisible. Against a payload without it, `.length` on the very
    // next render threw and took the WHOLE Settings screen down — an error
    // boundary reading "Cannot read properties of undefined", not an empty box.
    const { customInstructions: _omitted, ...withoutKey } = settings;
    geniro.getSettings.mockResolvedValue(withoutKey);
    await mount();

    expect(
      container.querySelector<HTMLTextAreaElement>(
        '#settings-custom-instructions',
      )?.value,
    ).toBe('');
    // The section rendered rather than the error boundary.
    expect(container.textContent).toContain('Custom instructions');
  });

  it('flushes a pending edit when Settings unmounts', async () => {
    // Same contract the CLI-path field has: navigating away mid-sentence must
    // not discard what was typed inside the debounce window.
    await mount();
    await typeInstructions('Prefer small diffs.');

    expect(geniro.updateSettings).not.toHaveBeenCalled();
    await act(async () => root?.unmount());
    root = null;

    expect(geniro.updateSettings).toHaveBeenCalledWith({
      customInstructions: 'Prefer small diffs.',
    });
  });

  it('does not overwrite what the user typed when the settings read lands late', async () => {
    // The async-read race the other fields guard against, and the one that
    // costs the most here: a slow read would silently replace a paragraph
    // mid-sentence rather than flipping a switch back.
    let resolveSettings!: (value: SettingsShape) => void;
    geniro.getSettings.mockReturnValueOnce(
      new Promise<SettingsShape>((resolve) => {
        resolveSettings = resolve;
      }),
    );
    await mount();
    await typeInstructions('MINE');

    await act(async () => {
      resolveSettings({ ...settings, customInstructions: 'STORED' });
      await Promise.resolve();
    });

    expect(
      container.querySelector<HTMLTextAreaElement>(
        '#settings-custom-instructions',
      )?.value,
    ).toBe('MINE');
  });

  it('does not attempt a write the settings schema would reject, and says so', async () => {
    // `settingsPatchSchema` carries the same ceiling, so an over-limit write
    // throws in the main process and saves nothing. Firing it anyway put a raw
    // zod string in the error slot while the caption still implied the text was
    // stored — so the value silently did not exist on disk. Nothing is written,
    // and the user is told in words.
    await mount();
    await typeInstructions('x'.repeat(MAX_CUSTOM_INSTRUCTIONS_CHARS + 1));

    await act(async () => root?.unmount());
    root = null;

    expect(geniro.updateSettings).not.toHaveBeenCalled();
  });

  it('does not flush an unsavable value that followed a legal one', async () => {
    // The sequence the first over-limit case could not reach: a LEGAL edit arms
    // the debounce, an over-limit edit then clears it — and if the timer ref is
    // merely cleared rather than nulled, the unmount flush still sees a handle
    // and writes the over-limit text. Nothing must be written at all here,
    // because the legal value was superseded and the current one is unsavable.
    await mount();
    await typeInstructions('legal so far');
    await typeInstructions('x'.repeat(MAX_CUSTOM_INSTRUCTIONS_CHARS + 1));

    await act(async () => root?.unmount());
    root = null;

    expect(geniro.updateSettings).not.toHaveBeenCalled();
  });

  it('refuses to save text carrying invisible control characters', async () => {
    // A soft line break pasted from a word processor (U+000B) is the realistic
    // case. Storing it would make every later chat create 400 at the daemon,
    // with the error surfacing in the composer rather than here.
    await mount();
    await typeInstructions(`be terse${String.fromCharCode(0x0b)}always`);

    // While still mounted — the message is what tells the user why nothing was
    // stored, and it has to be on screen at the moment they are typing.
    expect(container.textContent).toContain('control characters');

    await act(async () => root?.unmount());
    root = null;

    expect(geniro.updateSettings).not.toHaveBeenCalled();
  });

  it('keeps saving normally right up to the limit', async () => {
    // The control: the guard must refuse only what the schema refuses. Without
    // it, an off-by-one would silently stop persisting a legal value.
    await mount();
    await typeInstructions('x'.repeat(MAX_CUSTOM_INSTRUCTIONS_CHARS));

    await act(async () => root?.unmount());
    root = null;

    expect(geniro.updateSettings).toHaveBeenCalledWith({
      customInstructions: 'x'.repeat(MAX_CUSTOM_INSTRUCTIONS_CHARS),
    });
  });

  /** The purge control under the instructions box. */
  function forgetButton(): HTMLButtonElement | undefined {
    return [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.includes('Remove from existing chats'),
    );
  }

  it('purges the snapshot from existing runs on an explicit press, and says what it reached', async () => {
    // The escape hatch the snapshot design otherwise lacks. A PRESS, not a
    // side effect of clearing the box: it discards the per-run guarantee, so
    // an edit the user is halfway through must not trigger it.
    chatsApi.forgetCustomInstructions.mockResolvedValue({ cleared: 3 });
    await mount();

    await act(async () => {
      forgetButton()?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(chatsApi.forgetCustomInstructions).toHaveBeenCalled();
    expect(container.textContent).toContain('Removed from 3 existing runs');
  });

  it('distinguishes "nothing to forget" from a press that did nothing', async () => {
    // Without the count the two are identical on screen, and a user pressing a
    // button that appears inert cannot tell which happened.
    chatsApi.forgetCustomInstructions.mockResolvedValue({ cleared: 0 });
    await mount();

    await act(async () => {
      forgetButton()?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).toContain('No existing chat was carrying');
  });

  it('does not purge merely because the box was cleared', async () => {
    // The whole reason this is a button: clearing the box changes the NEXT
    // chat, and must never reach back into conversations already started.
    await mount();
    await typeInstructions('');

    expect(chatsApi.forgetCustomInstructions).not.toHaveBeenCalled();
  });

  it('previews the daemon’s own preamble rather than a copy of it', async () => {
    // The preview must show what the CLIs actually receive. Sourced from
    // GET /v1/capabilities so it cannot drift; rendering a renderer-side copy
    // is the failure this asserts against.
    // `claudeModes` must be present: the shared fetcher reads it to decide
    // whether to re-poll, and a mock without it throws INSIDE the hook's
    // promise chain, where the catch turns it into "no answer" — which looks
    // exactly like the preamble legitimately not having arrived.
    capabilitiesApi.getCapabilities.mockResolvedValue({
      hostPreamble: 'PREAMBLE FROM THE DAEMON',
      claudeModes: { acceptEdits: 'pass', plan: 'pass' },
      configDirs: [],
    } as unknown as Awaited<
      ReturnType<typeof capabilitiesApi.getCapabilities>
    >);
    await mount();

    expect(
      container.querySelector('[data-slot="host-preamble"]')?.textContent,
    ).toContain('PREAMBLE FROM THE DAEMON');
  });

  it('shows no preamble block at all while the daemon has not answered', async () => {
    // The honest rendering before the read lands: nothing. An empty box
    // captioned "geniro already tells every agent this" would state that the
    // app sends nothing, which is the opposite of true.
    await mount();

    expect(container.querySelector('[data-slot="host-preamble"]')).toBeNull();
  });
});

describe('Settings — CLI sign-in', () => {
  /** The cursor row is collapsed at rest — its Sign in control renders only
   *  once the row is expanded. */
  async function expandCursorRow(): Promise<void> {
    const toggle = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('cursor-agent'),
    )!;
    await act(async () => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  }

  function signInButton(): HTMLButtonElement | undefined {
    return Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((b) => b.textContent?.includes('Sign in'));
  }

  it('runs the sign-in IN the app — no terminal window opens', async () => {
    // THE REPORTED COMPLAINT. This used to resolve an invocation and hand it to
    // the user's terminal; a window opening for an ordinary sign-in was the thing
    // being fixed. `openInTerminal` staying untouched is the assertion that
    // matters — reverting to the handoff path fails here rather than merely
    // changing which call was made.
    geniro.detectClis.mockResolvedValue([
      det('claude'),
      det('cursor-agent', { loggedIn: false }),
    ]);
    cliAuthApi.startCliLogin.mockResolvedValue({
      id: 'login-1',
      agent: 'cursor-agent',
      status: 'waiting',
      url: 'https://cursor.com/login?uuid=1',
      message: 'Waiting for browser authentication...',
    });
    await mount();
    await expandCursorRow();

    const button = signInButton();
    expect(button).toBeDefined();
    await act(async () => {
      button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // No config directory: Settings signs in to the CLI's default profile, not
    // any one chat's.
    expect(cliAuthApi.startCliLogin).toHaveBeenCalledWith({
      agent: 'cursor-agent',
    });
    expect(geniro.openInTerminal).not.toHaveBeenCalled();
    // And the user is told what is happening, since the terminal used to be the
    // progress display.
    expect(container.textContent).toContain('Waiting for you to finish');
  });

  it('runs the sign-out in place and re-probes, instead of opening a window', async () => {
    // Probe-verified headless (claude 2.1.228, stdin closed, exit 0), so there is
    // nothing a window would add. The re-probe is the part the user sees: it is
    // what flips the card's own status line.
    geniro.detectClis.mockResolvedValue([
      det('claude'),
      det('cursor-agent', { loggedIn: true }),
    ]);
    await mount();
    await expandCursorRow();
    const before = geniro.detectClis.mock.calls.length;

    const signOut = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((b) => b.textContent?.includes('Sign out'));
    expect(signOut).toBeDefined();
    await act(async () => {
      signOut!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(cliAuthApi.cliLogout).toHaveBeenCalledWith({
      agent: 'cursor-agent',
    });
    expect(geniro.openInTerminal).not.toHaveBeenCalled();
    // Re-asked the CLI rather than assuming the exit code meant signed-out.
    expect(geniro.detectClis.mock.calls.length).toBeGreaterThan(before);
  });

  it('surfaces a refused sign-out rather than silently doing nothing', async () => {
    geniro.detectClis.mockResolvedValue([
      det('claude'),
      det('cursor-agent', { loggedIn: true }),
    ]);
    cliAuthApi.cliLogout.mockResolvedValue({
      agent: 'cursor-agent',
      ok: false,
      unavailableReason: 'this CLI has no sign-out command',
    });
    await mount();
    await expandCursorRow();

    await act(async () => {
      Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
        .find((b) => b.textContent?.includes('Sign out'))!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).toContain('this CLI has no sign-out command');
  });

  it('reports a sign-in the daemon refuses, without a window either way', async () => {
    geniro.detectClis.mockResolvedValue([
      det('claude'),
      det('cursor-agent', { loggedIn: false }),
    ]);
    cliAuthApi.startCliLogin.mockRejectedValue(
      new Error(
        'daemon POST /v1/auth/login failed (400): CLI_LOGIN_UNSUPPORTED',
      ),
    );
    await mount();
    await expandCursorRow();

    await act(async () => {
      signInButton()!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(geniro.openInTerminal).not.toHaveBeenCalled();
    expect(container.textContent).toContain('CLI_LOGIN_UNSUPPORTED');
  });
});

describe('Settings diagnostics section', () => {
  const inspectToggle = (): HTMLButtonElement =>
    container.querySelector<HTMLButtonElement>('#settings-daemon-inspect')!;

  it('shows the unchosen inspector as ON in dev, and marks the default as not the user’s', async () => {
    geniro.getSettings.mockResolvedValue({ ...settings, daemonInspect: null });
    await mount();

    // The dev daemon IS listening on that port, so rendering the stored
    // `null` as off would state the opposite of the machine's real state —
    // for a setting whose entire subject is an open debugger port.
    expect(inspectToggle().getAttribute('aria-checked')).toBe('true');
    expect(inspectToggle().closest('section')?.textContent).toContain(
      'default for dev',
    );
  });

  it('shows the same unchosen inspector as OFF once packaged', async () => {
    geniro.getStatus.mockResolvedValue({
      onboardingComplete: true,
      daemon: { connected: true, handle: null },
      isPackaged: true,
    });
    geniro.getSettings.mockResolvedValue({ ...settings, daemonInspect: null });
    await mount();

    // Same stored value, opposite answer. Dev and the installed app share one
    // settings.json, so this split cannot come from the stored value alone —
    // which is the whole reason the setting is not a plain boolean.
    expect(inspectToggle().getAttribute('aria-checked')).toBe('false');
    expect(inspectToggle().closest('section')?.textContent).toContain(
      'default for the installed app',
    );
  });

  it('keeps an explicit off through a dev launch, where the default says on', async () => {
    geniro.getSettings.mockResolvedValue({ ...settings, daemonInspect: false });
    await mount();

    // A developer who deliberately closed the port must not have it reopened
    // by the per-build default.
    expect(inspectToggle().getAttribute('aria-checked')).toBe('false');
    expect(inspectToggle().closest('section')?.textContent).not.toContain(
      'default for',
    );
  });

  it('writes an explicit boolean on flip, which is what triggers the respawn', async () => {
    geniro.getSettings.mockResolvedValue({ ...settings, daemonInspect: null });
    await mount();
    expect(inspectToggle().getAttribute('aria-checked')).toBe('true');

    await act(async () => {
      inspectToggle().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // `false`, never back to `null`: from an unchosen-but-on state, writing
    // null would persist nothing and leave the switch stuck on. And the key
    // must reach main under its own name — main restarts the daemon on
    // `daemonInspect` specifically.
    expect(geniro.updateSettings).toHaveBeenCalledWith({
      daemonInspect: false,
    });
    expect(inspectToggle().getAttribute('aria-checked')).toBe('false');
  });

  it('says which port to attach to, so the user is not left to guess', async () => {
    await mount();

    const section = inspectToggle().closest('section')!;
    expect(section.textContent).toContain(`127.0.0.1:${DAEMON_INSPECT_PORT}`);
    expect(section.textContent).toContain('chrome://inspect');
  });
});

describe('Settings — sections', () => {
  const navButtons = (): string[] =>
    [
      ...container.querySelectorAll<HTMLButtonElement>(
        'nav[aria-label="Settings sections"] button',
      ),
    ].map((button) => button.textContent ?? '');

  it('offers the sections as a nav beside the pane, General first', async () => {
    // General first because it is what Settings has always been — a screen
    // that reordered itself around a new feature would move every control the
    // user already knows where to find.
    await mount();
    expect(navButtons()).toEqual([
      'General',
      'Run configurations',
      'Fast actions',
    ]);
  });

  it('keeps run configurations and fast actions as two separate panes', async () => {
    // They are different features — one says where and with what a chat runs,
    // the other says what it says — and collapsing them into a single surface
    // is what destroyed the saved configurations once. This is the cheap guard
    // against a later tidy-up folding them back together.
    await mount('run-configurations');
    expect(container.textContent).toContain('No configurations yet');
    expect(container.textContent).not.toContain('No fast actions yet');

    await mount('fast-actions');
    expect(container.textContent).toContain('No fast actions yet');
    expect(container.textContent).not.toContain('No configurations yet');
  });

  it('shows ONE pane at a time', async () => {
    await mount();
    expect(container.textContent).toContain('Agents');
    expect(container.textContent).not.toContain('No fast actions yet');
  });

  it('opens straight at the section it was asked for', async () => {
    // The whole point of the section being a prop: the composer's "Manage fast
    // actions" lands ON the editor rather than on General with a hunt for it.
    await mount('fast-actions');
    expect(container.textContent).toContain('No fast actions yet');
    expect(container.textContent).not.toContain('Check for updates');
  });

  it('marks the open section for a screen reader, not by colour alone', async () => {
    await mount('fast-actions');
    const current = [
      ...container.querySelectorAll(
        'nav[aria-label="Settings sections"] button',
      ),
    ].filter((button) => button.getAttribute('aria-current') === 'page');
    expect(current.map((button) => button.textContent)).toEqual([
      'Fast actions',
    ]);
  });
});

describe('Settings — fast actions', () => {
  const action = {
    id: 'fa-1',
    name: 'Geniro app',
    description: 'Review what changed.',
  };

  it('lists what settings.json holds, without a chat ever being opened', async () => {
    // This screen reads its own data. It used to be a dialog inside Chats,
    // which had the list already loaded; a Settings pane that waited to be
    // handed one would be empty on a launch straight into Settings.
    geniro.getSettings.mockResolvedValue({
      ...settings,
      fastActions: [action],
    });
    await mount('fast-actions');
    expect(container.textContent).toContain('Geniro app');
  });

  it('rolls the list back when the write is refused', async () => {
    // Main VALIDATES the patch and throws, rejecting the WHOLE write. Leaving
    // the optimistic entry on screen both lies about what is saved and makes
    // every later save fail on the same entry, since the full array is re-sent.
    geniro.getSettings.mockResolvedValue({
      ...settings,
      fastActions: [action],
    });
    await mount('fast-actions');
    geniro.updateSettings.mockRejectedValueOnce(
      new Error('fastActions: too_big'),
    );

    const press = (label: string): void => {
      const button = [
        ...container.querySelectorAll<HTMLButtonElement>('button'),
      ].find((b) => b.getAttribute('aria-label') === label);
      if (!button) {
        throw new Error(`no button "${label}"`);
      }
      act(() => button.click());
    };
    press('Delete Geniro app');
    press('Confirm delete Geniro app');
    await act(async () => {
      await Promise.resolve();
    });

    // The delete was refused, so the action must still be listed.
    expect(container.textContent).toContain('Geniro app');
  });
});

describe('Settings appearance section', () => {
  beforeEach(() => {
    // jsdom ships no matchMedia, and picking a theme resolves through it —
    // `apply-theme.ts` reads the OS appearance to answer "System".
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    delete document.documentElement.dataset.theme;
  });

  /*
   * The picker is a run of SWATCHES, not a dropdown — every option is on
   * screen at rest, so there is no menu to open first. What the screen owes
   * is unchanged: the manifest's themes, the stored one marked, the pick
   * persisted AND painted, and the paint rolled back if the write is refused.
   */
  function swatches(): HTMLButtonElement[] {
    return [
      ...container.querySelectorAll<HTMLButtonElement>(
        '[data-slot="theme-picker"] button',
      ),
    ];
  }

  function swatchNamed(label: string): HTMLButtonElement {
    const found = swatches().find(
      (candidate) => (candidate.textContent ?? '').trim() === label,
    );
    if (!found) {
      throw new Error(`no "${label}" swatch`);
    }
    return found;
  }

  function chosenSwatch(): string | undefined {
    return swatches()
      .find((candidate) => candidate.getAttribute('aria-pressed') === 'true')
      ?.textContent?.trim();
  }

  it('offers System and every theme the app ships', async () => {
    await mount();

    // Expected from the MANIFEST so a third theme needs no edit here. It does
    // not yet DISCRIMINATE — with two themes, a hardcoded picker produces the
    // same three labels — so what this pins today is the options and their
    // order; the manifest-derived expectation is what carries the claim once a
    // third theme exists.
    expect(
      swatches().map((swatch) => (swatch.textContent ?? '').trim()),
    ).toEqual(['System', ...THEMES.map((theme) => theme.label)]);
  });

  it('opens on the stored preference rather than on the default', async () => {
    geniro.getSettings.mockResolvedValue({ ...settings, theme: 'dark' });

    await mount();

    expect(chosenSwatch()).toBe('Dark');
  });

  it('persists the pick and repaints the document without waiting for a reload', async () => {
    await mount();

    await act(async () => {
      swatchNamed('Dark').click();
    });

    expect(geniro.updateSettings).toHaveBeenCalledWith({ theme: 'dark' });
    // The repaint is the half a persist alone would not give: `data-theme` is
    // what every token selector keys on.
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('rolls the page back when the write is refused, so it cannot disagree with the OS chrome', async () => {
    // The page repaints HERE; the OS chrome repaints in MAIN when the write
    // lands. Swallowing the rejection would leave a dark page under light
    // traffic lights until the next launch — the split main-side application
    // exists to prevent.
    geniro.updateSettings.mockRejectedValueOnce(new Error('disk full'));
    await mount();

    await act(async () => {
      swatchNamed('Dark').click();
    });

    expect(document.documentElement.dataset.theme).toBe('light');
    expect(chosenSwatch()).toBe('System');
  });
});
