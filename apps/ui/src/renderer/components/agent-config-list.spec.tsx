// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CliDetection, CliKind } from '../../shared/contracts';
import { AgentConfigList, statusFor } from './agent-config-list';
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
          {
            kind: 'claude',
            found: true,
            path: '/usr/local/bin/claude',
            version: '1.2.3',
            loggedIn: null,
          },
          {
            kind: 'cursor-agent',
            found: false,
            path: null,
            version: null,
            loggedIn: null,
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
    return [...el.querySelectorAll('button')]
      .filter(
        (b) =>
          b.textContent?.includes('Sign in') === true ||
          b.textContent?.includes('Sign out') === true,
      )
      .map((button) => ({
        label: button.textContent?.includes('Sign out')
          ? 'Sign out'
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
