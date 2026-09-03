// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  CliDetection,
  CliKind,
  CliUpdateState,
} from '../../shared/contracts';
import { AgentConfigList, cliUpdateRow, statusFor } from './agent-config-list';
import type { StatusTone } from './status-dot';

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
    // Nothing known about updates unless a case says so — the state a CLI with
    // no check of its own reports, so the default exercises no new behaviour.
    update: {
      available: null,
      latestVersion: null,
      checkUnavailableReason: null,
    },
    ...overrides,
  };
}

const bothFound: CliDetection[] = [det('claude'), det('cursor-agent')];
const noneFound: CliDetection[] = [
  det('claude', { found: false, path: null, version: null }),
  det('cursor-agent', { found: false, path: null, version: null }),
];

describe('statusFor', () => {
  // The rule is generic over the FIELD, not the CLI name: any found agent whose
  // own answer is not explicitly `false` reads ready. (This used to note that
  // claude could never answer at all. It can — `claude auth status --json` —
  // and `LOGIN_PROBES` now asks it; the rule below is unchanged either way,
  // which is the point of keying on the field.)
  it.each([null, true] as (boolean | null)[])(
    'found claude with loggedIn=%s is ready',
    (loggedIn) => {
      const clis = [det('claude', { loggedIn }), det('cursor-agent')];
      expect(statusFor(clis, 'claude').tone).toBe('ok');
    },
  );

  // Either CLI's own answer can flip this — asserted through cursor-agent.
  it.each([
    { loggedIn: true, tone: 'ok' },
    { loggedIn: false, tone: 'warn' },
    // The safety property this whole shape exists for: a failed/absent probe
    // must NOT read as signed-out, or a signed-in user would be told to sign
    // in for nothing.
    { loggedIn: null, tone: 'ok' },
  ] as { loggedIn: boolean | null; tone: StatusTone }[])(
    'found cursor-agent with loggedIn=$loggedIn → $tone',
    ({ loggedIn, tone }) => {
      const clis = [det('claude'), det('cursor-agent', { loggedIn })];
      expect(statusFor(clis, 'cursor-agent').tone).toBe(tone);
    },
  );

  it.each(['claude', 'cursor-agent'] as CliKind[])(
    'not-found %s is bad regardless of loggedIn',
    (kind) => {
      expect(statusFor(noneFound, kind)).toEqual({
        label: 'not found on PATH',
        tone: 'bad',
      });
      // A kind with no detection entry at all reads the same as not-found.
      expect(statusFor([], kind).tone).toBe('bad');
    },
  );

  it('reports unknown while detection is still running (clis null)', () => {
    for (const kind of ['claude', 'cursor-agent'] as CliKind[]) {
      expect(statusFor(null, kind)).toEqual({
        label: 'Checking…',
        tone: 'unknown',
      });
    }
  });

  it('labels carry the probed version when present', () => {
    expect(statusFor(bothFound, 'claude').label).toBe('ready · 1.2.3');
    expect(
      statusFor(
        [det('claude'), det('cursor-agent', { loggedIn: false })],
        'cursor-agent',
      ).label,
    ).toBe('detected · 1.2.3 · not signed in');

    const versionless = [
      det('claude', { version: null }),
      det('cursor-agent', { version: null }),
    ];
    expect(statusFor(versionless, 'claude').label).toBe('ready');
  });
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render(element: React.ReactElement): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(element);
  });
  return container;
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

describe('AgentConfigList — CLI sign-in control', () => {
  const baseProps = {
    clis: bothFound,
    open: { claude: true, 'cursor-agent': true },
    onToggle: vi.fn(),
    binaryPaths: {},
    onBinaryPathChange: vi.fn(),
    onBrowse: vi.fn(),
  };

  it('offers no sign-in control when the owner passes none — onboarding’s shape', () => {
    const el = render(<AgentConfigList {...baseProps} />);
    expect(
      [...el.querySelectorAll('button')].some((b) =>
        b.textContent?.includes('Sign in'),
      ),
    ).toBe(false);
  });

  it('offers a sign-in control per agent when the owner supplies one — Settings’ shape', () => {
    const onSignIn = vi.fn();
    const el = render(<AgentConfigList {...baseProps} onSignIn={onSignIn} />);
    const buttons = [...el.querySelectorAll('button')].filter((b) =>
      b.textContent?.includes('Sign in'),
    );
    expect(buttons).toHaveLength(2);

    act(() => {
      buttons[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onSignIn).toHaveBeenCalledWith('claude');
  });

  it('offers no sign-in for a binary that was not found', () => {
    const onSignIn = vi.fn();
    // The daemon resolves a login target from the bare CLI name and never checks
    // it exists, so this control would open a terminal answering `command not
    // found` — outside the app, where no error banner can reach the user. Drop
    // the `found` half of the gate and this renders two buttons instead of one.
    const el = render(
      <AgentConfigList
        {...baseProps}
        clis={[
          det('claude', { path: '/usr/local/bin/claude' }),
          {
            kind: 'cursor-agent',
            found: false,
            path: null,
            version: null,
            loggedIn: null,
            update: {
              available: null,
              latestVersion: null,
              checkUnavailableReason: null,
            },
          },
        ]}
        onSignIn={onSignIn}
      />,
    );

    const buttons = [...el.querySelectorAll('button')].filter((b) =>
      b.textContent?.includes('Sign in'),
    );
    expect(buttons).toHaveLength(1);

    // WHICH card carries it, not just how many: inverting the gate to
    // `onSignIn && !found` also yields exactly one button — on the not-found
    // card, the precise state this test forbids. Only the callback argument
    // localizes it.
    act(() => {
      buttons[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onSignIn).toHaveBeenCalledWith('claude');
  });
});

describe('AgentConfigList — the account control matches the reported state', () => {
  const baseProps = {
    open: { claude: true, 'cursor-agent': true },
    onToggle: vi.fn(),
    binaryPaths: {},
    onBinaryPathChange: vi.fn(),
    onBrowse: vi.fn(),
  };

  /** Every account button on screen, as `label → the kind it acts on`. */
  function accountButtons(
    el: HTMLElement,
  ): { label: string; button: HTMLButtonElement }[] {
    // `Signing in…` is matched explicitly rather than by prefix: it does NOT
    // contain the substring `Sign in`, so a filter on that alone drops the very
    // state these tests are about and reports an empty list instead of a wrong
    // one.
    return [...el.querySelectorAll('button')]
      .filter(
        (b) =>
          b.textContent?.includes('Sign in') === true ||
          b.textContent?.includes('Signing in') === true ||
          b.textContent?.includes('Sign out') === true,
      )
      .map((button) => ({
        label: button.textContent?.includes('Sign out')
          ? 'Sign out'
          : button.textContent?.includes('Signing in')
            ? 'Signing in…'
            : 'Sign in',
        button: button as HTMLButtonElement,
      }));
  }

  it('offers SIGN OUT, not sign in, to a CLI that reports itself signed in', () => {
    // THE REPORTED DEFECT. The card offered Sign in to every detected CLI,
    // including one the probe had just confirmed signed in — an action the user
    // cannot need, on the screen they check to see whether setup is done.
    const onSignIn = vi.fn();
    const onSignOut = vi.fn();
    const el = render(
      <AgentConfigList
        {...baseProps}
        clis={[
          det('claude', { loggedIn: true }),
          det('cursor-agent', { loggedIn: true }),
        ]}
        onSignIn={onSignIn}
        onSignOut={onSignOut}
      />,
    );

    const found = accountButtons(el);
    expect(found.map((f) => f.label)).toEqual(['Sign out', 'Sign out']);

    act(() => {
      found[1]!.button.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });
    // The kind is what localizes it: two Sign out buttons would also pass a
    // count-only assertion with both wired to the first card.
    expect(onSignOut).toHaveBeenCalledWith('cursor-agent');
    expect(onSignIn).not.toHaveBeenCalled();
  });

  it('offers SIGN IN to a CLI that reports itself signed out', () => {
    const onSignIn = vi.fn();
    const onSignOut = vi.fn();
    const el = render(
      <AgentConfigList
        {...baseProps}
        clis={[
          det('claude', { loggedIn: false }),
          det('cursor-agent', { loggedIn: true }),
        ]}
        onSignIn={onSignIn}
        onSignOut={onSignOut}
      />,
    );

    // One of each, and on the right cards — a component that keyed the label off
    // anything but this field would put them the wrong way round and still show
    // one of each.
    expect(accountButtons(el).map((f) => f.label)).toEqual([
      'Sign in',
      'Sign out',
    ]);
    act(() => {
      accountButtons(el)[0]!.button.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });
    expect(onSignIn).toHaveBeenCalledWith('claude');
    expect(onSignOut).not.toHaveBeenCalled();
  });

  it('answers the PRESS, before the daemon has said anything', () => {
    // THE REPORTED DEFECT: "I press Sign In and there is no loader, nothing."
    // The panel below this button only exists once the daemon replies, and
    // that reply is held until the CLI prints its URL — measured at 4001ms in
    // the running app — so for four seconds a browser tab opens behind the
    // window while this button sits unchanged.
    const el = render(
      <AgentConfigList
        {...baseProps}
        clis={[det('claude', { loggedIn: false })]}
        onSignIn={vi.fn()}
        onSignOut={vi.fn()}
        signingIn="claude"
      />,
    );

    const button = accountButtons(el)[0]!;
    expect(button.label).toContain('Signing in…');
    // Disabled as well as spinning, and that is not cosmetic: a second press
    // starts a second browser challenge that invalidates the first.
    expect(button.button.disabled).toBe(true);
  });

  it('marks only the card whose sign-in is running', () => {
    // Two cards, one flag. A component that keyed the pending state off
    // anything but the kind would spin both.
    const el = render(
      <AgentConfigList
        {...baseProps}
        clis={[
          det('claude', { loggedIn: false }),
          det('cursor-agent', { loggedIn: false }),
        ]}
        onSignIn={vi.fn()}
        onSignOut={vi.fn()}
        signingIn="cursor-agent"
      />,
    );

    expect(accountButtons(el).map((f) => f.label)).toEqual([
      'Sign in',
      'Signing in…',
    ]);
  });

  it('offers SIGN IN when the state is unknown — never sign out on a guess', () => {
    // The asymmetry is the safety property. A probe that failed reports `null`;
    // offering Sign out there could destroy a working session on nothing more
    // than a timeout, while an unnecessary Sign in costs a re-auth the user can
    // cancel. Flip the component's default arm and this fails.
    const onSignOut = vi.fn();
    const el = render(
      <AgentConfigList
        {...baseProps}
        clis={[det('claude', { loggedIn: null })]}
        onSignIn={vi.fn()}
        onSignOut={onSignOut}
      />,
    );

    expect(accountButtons(el).map((f) => f.label)).toEqual(['Sign in']);
    expect(onSignOut).not.toHaveBeenCalled();
  });

  it('names the PROFILE it is reporting on, for a CLI whose account is per-profile', () => {
    // The ambiguity this closes: the row's probe and its button both run with no
    // config directory, so they are about the DEFAULT profile — while a chat can
    // run under another one, on another subscription. Unqualified, a user whose
    // chats run under `~/profiles/work` reads "not signed in" beside runs that
    // are working fine.
    const el = render(
      <AgentConfigList
        {...baseProps}
        clis={[
          det('claude', { loggedIn: true }),
          det('cursor-agent', { loggedIn: true }),
        ]}
        onSignIn={vi.fn()}
        onSignOut={vi.fn()}
        // claude's account IS per-profile; cursor-agent's is not — it reads a
        // config directory but keeps the account outside it, so a "Default
        // profile" prefix there would invent a distinction it does not have.
        profileScopedKinds={new Set(['claude'])}
      />,
    );

    const text = el.textContent ?? '';
    expect(text).toContain(
      'Default profile · signed in through the claude CLI',
    );
    // And NOT on the CLI that has no profiles — the whole point of driving this
    // from the daemon's capability rather than applying it to every card.
    expect(text).toContain('Signed in through the cursor-agent CLI');
    expect(text).not.toContain(
      'Default profile · signed in through the cursor',
    );
  });

  it('adds no profile qualifier when nothing says the account is per-profile', () => {
    // Onboarding's shape, and the pre-capability moment on Settings. At first run
    // there are no profiles to distinguish, and a prefix that might be wrong is
    // worse than none.
    const el = render(
      <AgentConfigList
        {...baseProps}
        clis={[det('claude', { loggedIn: false })]}
        onSignIn={vi.fn()}
      />,
    );

    expect(el.textContent).toContain('Not signed in');
    expect(el.textContent).not.toContain('Default profile');
  });

  it('renders NO control rather than the wrong verb when its handler is absent', () => {
    // Onboarding's shape, now that the state can call for either action: a
    // signed-in card with no `onSignOut` must show nothing, not fall through to
    // Sign in. Falling through would put the one action the user cannot need on
    // the one screen with no way to reach the right one.
    const el = render(
      <AgentConfigList
        {...baseProps}
        clis={[det('claude', { loggedIn: true })]}
        onSignIn={vi.fn()}
      />,
    );

    expect(accountButtons(el)).toHaveLength(0);
  });
});

describe('cliUpdateRow', () => {
  const nothingKnown: CliUpdateState = {
    available: null,
    latestVersion: null,
    checkUnavailableReason: null,
  };

  it('offers the press when the CLI cannot be asked, and says why', () => {
    // claude's shape, and the case the whole three-state design exists for:
    // running its updater IS its only check, so an unaskable CLI must still
    // offer the button. Collapse `null` into "no update" and the one CLI that
    // can never advertise one loses its only way to be updated.
    const row = cliUpdateRow(
      { ...nothingKnown, checkUnavailableReason: 'claude has no check.' },
      undefined,
    );

    expect(row).toEqual({
      text: 'claude has no check.',
      tone: 'muted',
      offer: true,
    });
  });

  it('offers nothing when the CLI answered that it is up to date', () => {
    // The app's own rule about controls with nothing behind them. Re-asking is
    // what `Re-check` above the list does, and it re-runs this very probe.
    expect(
      cliUpdateRow({ ...nothingKnown, available: false }, undefined),
    ).toEqual({ text: 'Up to date', tone: 'muted', offer: false });
  });

  it('names the waiting version when the CLI reported one', () => {
    expect(
      cliUpdateRow(
        {
          available: true,
          latestVersion: '2026.09.02-c22c1a3',
          checkUnavailableReason: null,
        },
        undefined,
      ),
    ).toEqual({
      text: 'Update available · 2026.09.02-c22c1a3',
      tone: 'news',
      offer: true,
    });

    // An update the CLI announced without naming a version still earns the
    // press — the row simply has one fewer fact to state.
    expect(
      cliUpdateRow({ ...nothingKnown, available: true }, undefined),
    ).toEqual({
      text: 'Update available',
      tone: 'news',
      offer: true,
    });
  });

  it('reports a new version only when the binary actually answered differently', () => {
    const result = {
      kind: 'cursor-agent' as const,
      ok: true,
      previousVersion: '2026.08.11',
      version: '2026.09.02-c22c1a3',
      output: null,
    };

    // The check still says an update is waiting — it was taken BEFORE the
    // install — and the outcome outranks it, or the card would go on offering
    // the update it has just applied.
    expect(
      cliUpdateRow(
        {
          available: true,
          latestVersion: '2026.09.02-c22c1a3',
          checkUnavailableReason: null,
        },
        result,
      ),
    ).toEqual({
      text: 'Updated to 2026.09.02-c22c1a3',
      tone: 'ok',
      offer: false,
    });

    // Same version back: the updater ran and nothing moved.
    expect(
      cliUpdateRow(nothingKnown, { ...result, version: '2026.08.11' }),
    ).toEqual({
      text: 'Already on the latest version',
      tone: 'muted',
      offer: false,
    });
  });

  it('claims nothing about the version when either read failed', () => {
    // A clean exit with an unreadable `--version` is not evidence of being up
    // to date. Reporting "Already on the latest version" here would state a
    // comparison that never happened.
    for (const versions of [
      { previousVersion: null, version: '2.1.255' },
      { previousVersion: '2.1.251', version: null },
    ]) {
      expect(
        cliUpdateRow(nothingKnown, {
          kind: 'claude',
          ok: true,
          output: null,
          ...versions,
        }),
      ).toEqual({ text: 'Update finished', tone: 'muted', offer: false });
    }
  });

  it('keeps the press after a failure, so a retry is one click away', () => {
    expect(
      cliUpdateRow(nothingKnown, {
        kind: 'claude',
        ok: false,
        previousVersion: '2.1.251',
        version: '2.1.251',
        output: 'permission denied',
      }),
    ).toEqual({ text: 'Update failed', tone: 'bad', offer: true });
  });
});

describe('AgentConfigList — the update band', () => {
  const baseProps = {
    clis: bothFound,
    open: { claude: true, 'cursor-agent': true },
    onToggle: vi.fn(),
    binaryPaths: {},
    onBinaryPathChange: vi.fn(),
    onBrowse: vi.fn(),
  };

  // `Updat`, not `Update`: a running card's button reads `Updating…`, so the
  // obvious substring silently drops the very button the disabled case is about.
  const updateButtons = (el: HTMLElement): HTMLButtonElement[] =>
    [...el.querySelectorAll('button')].filter((b) =>
      b.textContent?.startsWith('Updat'),
    );

  it('draws no band at all when the owner passes no handler — onboarding’s shape', () => {
    // An out-of-date CLI is not a setup step, and onboarding has nowhere to
    // report what an update did.
    const el = render(<AgentConfigList {...baseProps} />);

    expect(updateButtons(el)).toHaveLength(0);
    expect(el.textContent).not.toContain('Up to date');
  });

  it('presses through to the card’s own kind', () => {
    const onUpdate = vi.fn();
    const el = render(
      <AgentConfigList
        {...baseProps}
        clis={[
          det('claude', {
            update: {
              available: true,
              latestVersion: '2.1.255',
              checkUnavailableReason: null,
            },
          }),
          det('cursor-agent', {
            update: {
              available: false,
              latestVersion: null,
              checkUnavailableReason: null,
            },
          }),
        ]}
        onUpdate={onUpdate}
      />,
    );

    // Exactly one button: cursor answered "up to date" and offers no press,
    // which is also what localizes the click below to the right card.
    const buttons = updateButtons(el);
    expect(buttons).toHaveLength(1);
    act(() => {
      buttons[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onUpdate).toHaveBeenCalledWith('claude');
  });

  it('offers no update for a binary that was not found', () => {
    // The same gate the sign-in control carries, for its reason: pressing this
    // would run a binary that is not there.
    const el = render(
      <AgentConfigList
        {...baseProps}
        clis={[
          det('claude', {
            found: false,
            path: null,
            version: null,
            update: {
              available: true,
              latestVersion: '2.1.255',
              checkUnavailableReason: null,
            },
          }),
        ]}
        onUpdate={vi.fn()}
      />,
    );

    expect(updateButtons(el)).toHaveLength(0);
  });

  it('disables the running card’s button and leaves the other card alone', () => {
    const el = render(
      <AgentConfigList
        {...baseProps}
        clis={[
          det('claude', {
            update: {
              available: true,
              latestVersion: '2.1.255',
              checkUnavailableReason: null,
            },
          }),
          det('cursor-agent', {
            update: {
              available: true,
              latestVersion: '2026.09.02',
              checkUnavailableReason: null,
            },
          }),
        ]}
        onUpdate={vi.fn()}
        updating="claude"
      />,
    );

    const buttons = updateButtons(el);
    expect(buttons).toHaveLength(2);
    // A second press would run a second installer over the files the first is
    // writing, so the running card's button is disabled — and only that one.
    expect(buttons[0]!.disabled).toBe(true);
    expect(buttons[1]!.disabled).toBe(false);
  });

  it('carries a failed updater’s own words on the row', () => {
    const el = render(
      <AgentConfigList
        {...baseProps}
        clis={[det('claude')]}
        onUpdate={vi.fn()}
        updateResults={{
          claude: {
            kind: 'claude',
            ok: false,
            previousVersion: '2.1.251',
            version: '2.1.251',
            output: 'permission denied',
          },
        }}
      />,
    );

    // The one state this app cannot explain, so the tool's own sentence is the
    // only thing worth showing — and it is reachable rather than swallowed.
    const row = [...el.querySelectorAll('span')].find(
      (s) => s.textContent === 'Update failed',
    );
    expect(row?.getAttribute('title')).toBe('permission denied');
  });
});
