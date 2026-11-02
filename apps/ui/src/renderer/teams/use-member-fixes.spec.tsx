// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DaemonApis } from '../daemon-api';
import type { MemberProblem } from './member-problems';
import { type MemberFix, useMemberFixes } from './use-member-fixes';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function problem(over: Partial<MemberProblem>): MemberProblem {
  return {
    key: 'k',
    memberId: 'ada',
    kind: 'signed_out',
    level: 'warning',
    message: 'm',
    agent: 'claude',
    configDir: null,
    server: null,
    servers: [],
    poolMember: null,
    ...over,
  };
}

interface Mounted {
  fixOf: (p: MemberProblem) => MemberFix | undefined;
  openMember: ReturnType<typeof vi.fn>;
  openSettings: ReturnType<typeof vi.fn>;
}

function mount(apis: DaemonApis | null): Mounted {
  const openMember = vi.fn();
  const openSettings = vi.fn();
  const mounted = { openMember, openSettings } as Mounted;
  function Probe(): React.JSX.Element {
    const { fixOf, dialogs } = useMemberFixes({
      apis,
      openMember,
      openSettings,
      onFixed: () => {},
    });
    mounted.fixOf = fixOf;
    return <>{dialogs}</>;
  }
  act(() => root.render(<Probe />));
  return mounted;
}

describe('useMemberFixes', () => {
  it('starts a sign-in with the member’s agent and profile for a signed-out CLI', async () => {
    const startCliLogin = vi.fn(() =>
      Promise.resolve({
        id: 's1',
        status: 'waiting',
        url: null,
        message: null,
      }),
    );
    const apis = { cliAuth: { startCliLogin } } as unknown as DaemonApis;
    const { fixOf } = mount(apis);
    const fix = fixOf(
      problem({ kind: 'signed_out', agent: 'codex', configDir: '/p/work' }),
    );
    expect(fix?.label).toBe('Sign in');
    await act(async () => {
      fix!.run();
    });
    expect(startCliLogin).toHaveBeenCalledWith({
      agent: 'codex',
      configDir: '/p/work',
    });
    expect(container.textContent).toContain('Waiting for you to finish');
  });

  it('opens the MCP dialog for the problem’s agent and profile', async () => {
    const listAgentMcpServers = vi.fn(() =>
      Promise.resolve({
        servers: [],
        unavailableReason: null,
        interactiveOnlyNote: null,
        plugins: [],
        pending: false,
      }),
    );
    const apis = { agents: { listAgentMcpServers } } as unknown as DaemonApis;
    const { fixOf } = mount(apis);
    const fix = fixOf(
      problem({
        kind: 'mcp_failed',
        agent: 'cursor-agent',
        configDir: '/p/spare',
        server: 'github',
      }),
    );
    expect(fix?.label).toBe('Open MCP');
    act(() => fix!.run());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
    });
    expect(listAgentMcpServers).toHaveBeenCalledWith(
      { agent: 'cursor-agent', configDir: '/p/spare' },
      expect.anything(),
    );
    expect(document.body.textContent).toContain('MCP servers');
  });

  it('offers one server a sign-in and a folded row of several the MCP list', () => {
    const apis = { agents: {}, cliAuth: {} } as unknown as DaemonApis;
    const { fixOf } = mount(apis);
    expect(
      fixOf(problem({ kind: 'mcp_needs_auth', server: 'github' }))?.label,
    ).toBe('Sign in');
    expect(
      fixOf(problem({ kind: 'mcp_needs_auth', server: null }))?.label,
    ).toBe('Open MCP');
  });

  it('routes the setting kinds to Settings or to the member', () => {
    const { fixOf, openMember, openSettings } = mount(null);
    act(() => fixOf(problem({ kind: 'cli_missing' }))!.run());
    expect(openSettings).toHaveBeenCalledWith('general');
    const choose = fixOf(problem({ kind: 'model_not_offered' }));
    expect(choose?.label).toBe('Choose model');
    act(() => choose!.run());
    expect(openMember).toHaveBeenCalledWith('ada');
    expect(fixOf(problem({ kind: 'effort_not_offered' }))?.label).toBe(
      'Choose effort',
    );
    expect(fixOf(problem({ kind: 'profile_missing' }))?.label).toBe(
      'Choose profile',
    );
  });

  it('offers nothing for a team-level problem', () => {
    const { fixOf } = mount(null);
    expect(fixOf(problem({ kind: 'no_trigger' }))).toBeUndefined();
    expect(fixOf(problem({ kind: 'stage_member_missing' }))).toBeUndefined();
  });
});
