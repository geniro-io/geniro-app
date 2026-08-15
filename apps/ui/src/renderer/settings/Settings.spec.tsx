// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  CliDetection,
  CliKind,
  GeniroApi,
  Settings as SettingsShape,
} from '../../shared/contracts';
import { DAEMON_INSPECT_PORT, DEFAULT_SETTINGS } from '../../shared/contracts';
import { Settings } from './Settings';

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
  checkForUpdates: vi.fn(),
  openInTerminal: vi.fn(),
  notify: vi.fn(),
  onNotificationActivated: vi.fn().mockReturnValue(() => {}),
};

// The daemon client is mocked so Settings never issues a real fetch —
// `createDaemonApis` hands back one object per launch handle, so a single factory
// mock covers every client on it.
const handoffApi = vi.hoisted(() => ({ resolveCliLogin: vi.fn() }));
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
vi.mock('../daemon-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../daemon-api')>()),
  createDaemonApis: vi.fn(() => ({
    handoff: handoffApi,
    cliAuth: cliAuthApi,
    capabilities: capabilitiesApi,
  })),
}));

const handle = { host: '127.0.0.1', port: 8123, token: 'tok', version: '1' };

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

async function mount(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  const mountedRoot = createRoot(container);
  root = mountedRoot;
  await act(async () => {
    mountedRoot.render(<Settings handle={handle} />);
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
  geniro.checkForUpdates.mockReset().mockResolvedValue({
    status: 'up-to-date',
    version: '0.1.0',
    message: null,
  });
  handoffApi.resolveCliLogin.mockReset();
  cliAuthApi.cliLogout.mockReset().mockResolvedValue({
    agent: 'cursor-agent',
    ok: true,
    unavailableReason: null,
  });
  cliAuthApi.startCliLogin.mockReset();
  cliAuthApi.getCliLogin.mockReset();
  cliAuthApi.submitCliLoginCode.mockReset();
  cliAuthApi.cancelCliLogin.mockReset();
  (window as unknown as { geniro: Partial<GeniroApi> }).geniro =
    geniro as unknown as Partial<GeniroApi>;
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
  }
  container.remove();
});

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
    expect(label?.textContent).toBe('Check for app updates on launch');
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

  it('renders the available-update message (with the update command) and a failed check', async () => {
    geniro.checkForUpdates.mockResolvedValueOnce({
      status: 'available',
      version: '0.2.0',
      message: 'v0.2.0 is available — update with: brew upgrade --cask geniro',
    });
    await mount();
    const check = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Check now'),
    )!;

    await act(async () => {
      check.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    // Assert on text unique to the check RESULT, not the always-present static
    // hint (which also mentions brew) — else this passes with the result unshown.
    expect(container.textContent).toContain('v0.2.0 is available');

    geniro.checkForUpdates.mockRejectedValueOnce(new Error('ipc broke'));
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
    expect(handoffApi.resolveCliLogin).not.toHaveBeenCalled();
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
