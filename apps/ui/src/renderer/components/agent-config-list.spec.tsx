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
  // claude has no status command to ask (its credentials are handled another
  // way), so it always carries `loggedIn: null` in practice — but the rule
  // itself is generic over the FIELD, not the CLI name: any found agent whose
  // own answer is not explicitly `false` reads ready.
  it.each([null, true] as (boolean | null)[])(
    'found claude with loggedIn=%s is ready',
    (loggedIn) => {
      const clis = [det('claude', { loggedIn }), det('cursor-agent')];
      expect(statusFor(clis, 'claude').tone).toBe('ok');
    },
  );

  // cursor-agent is the one CLI whose own answer can flip this.
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
