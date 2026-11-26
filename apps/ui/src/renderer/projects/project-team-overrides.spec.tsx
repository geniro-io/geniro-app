// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPreloadStub } from '../__fixtures__/preload-stub';
import type * as daemonApiModule from '../daemon-api';
import { ProjectPageSlotsContext } from './project-page-slots';

const teamsApi = vi.hoisted(() => ({
  getTeam: vi.fn(),
  getTeamOverlay: vi.fn(),
  saveTeamOverlay: vi.fn(),
  deleteTeamOverlay: vi.fn(),
  readTeamHealth: vi.fn(),
  measureInstructionSizes: vi.fn(),
}));
const agentsApi = vi.hoisted(() => ({ listAgentMcpServers: vi.fn() }));
const capabilitiesApi = vi.hoisted(() => ({ getCapabilities: vi.fn() }));

vi.mock('../daemon-api', async (importOriginal) => ({
  ...(await importOriginal<typeof daemonApiModule>()),
}));

const { withVocabulary } = await import('../__tests__/agent-vocabulary-api');
const { ProjectTeamOverrides } = await import('./project-team-overrides');

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const apis = {
  teams: teamsApi,
  capabilities: capabilitiesApi,
  agents: withVocabulary({
    listAgentModels: async () => [],
    listAgentEfforts: async () => ({ efforts: [], unavailableReason: null }),
    listAgentContextWindows: async () => ({
      windows: [],
      unavailableReason: null,
      unavailableKind: null,
    }),
    listAgentModelParameters: async () => ({
      parameters: [],
      unavailableReason: null,
    }),
    listAgentMcpServers: agentsApi.listAgentMcpServers,
  }),
} as unknown as React.ComponentProps<typeof ProjectTeamOverrides>['apis'];

const server = (name: string): unknown => ({
  name,
  target: null,
  transport: 'stdio',
  status: 'connected',
  detail: null,
  scope: 'user',
  shadowsUser: false,
  disabled: false,
  toggleUnavailableReason: null,
  signInUnavailableReason: null,
  approveUnavailableReason: null,
  turnToggleUnavailableReason: null,
});

const crew = (member: Record<string, unknown> = {}): unknown => ({
  name: 'Crew',
  mode: 'lead',
  members: [
    {
      id: 'lead',
      name: 'Lead',
      agent: 'claude',
      approval: 'auto',
      instructions: 'Plan it.',
      ...member,
    },
  ],
  triggers: [{ kind: 'first-message', member: 'lead' }],
  instructionBlocks: [],
});

const overlayWire = (overlay: Record<string, unknown>): unknown => ({
  slug: 'crew',
  projectId: 'p1',
  overlay,
  hash: 'o-1',
  orphans: [],
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let sheet: HTMLDivElement | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  window.geniro = createPreloadStub();
  capabilitiesApi.getCapabilities.mockResolvedValue({
    agents: [],
    approvals: [],
    configDirs: [],
    interactiveTerminals: [],
    modelEfforts: [],
    options: [],
    followUps: [],
    mcpAllowLists: [
      {
        agent: 'claude',
        unavailableReason: null,
        accountConnectorPrefix: null,
      },
    ],
  });
  agentsApi.listAgentMcpServers.mockResolvedValue({
    servers: [server('codegraph'), server('linear')],
    plugins: [],
    unavailableReason: null,
    interactiveOnlyNote: null,
    pending: false,
  });
  teamsApi.saveTeamOverlay.mockImplementation(async ({ saveTeamOverlayDto }) =>
    overlayWire(saveTeamOverlayDto.overlay),
  );
  teamsApi.deleteTeamOverlay.mockResolvedValue({ deleted: true });
  teamsApi.readTeamHealth.mockResolvedValue({
    slug: 'crew',
    checkedAt: '2026-11-03T10:00:00.000Z',
    blocking: false,
    team: [],
    members: [],
  });
  teamsApi.measureInstructionSizes.mockResolvedValue({
    members: [],
    blocks: [],
  });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  sheet?.remove();
  root = null;
  container = null;
  sheet = null;
  vi.useRealTimers();
  vi.clearAllMocks();
});

async function settle(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });
}

async function mountWith(
  member: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Promise<void> {
  teamsApi.getTeam.mockResolvedValue({
    slug: 'crew',
    hash: 'team-1',
    team: crew(member),
  });
  teamsApi.getTeamOverlay.mockResolvedValue(overlayWire(overlay));
  container = document.createElement('div');
  sheet = document.createElement('div');
  document.body.append(container, sheet);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <ProjectPageSlotsContext.Provider value={{ sheet, dock: null }}>
        <ProjectTeamOverrides
          projectId="p1"
          projectName="Billing API"
          slug="crew"
          apis={apis}
          chatWorking={false}
          reloadKey={0}
          flushRef={{ current: null }}
          onOpenTeam={() => undefined}
        />
      </ProjectPageSlotsContext.Provider>,
    );
  });
  await settle();
  await act(async () => {
    container!
      .querySelector<HTMLElement>('[data-slot="member-card"]')!
      .closest('li')!
      .querySelector<HTMLButtonElement>(':scope > button')!
      .click();
  });
  await settle();
}

const button = (label: string): HTMLButtonElement | undefined =>
  [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) =>
      candidate.textContent?.trim() === label ||
      candidate.getAttribute('aria-label')?.startsWith(label),
  );

async function press(label: string): Promise<void> {
  await act(async () => button(label)!.click());
  await settle();
}

const savedLead = (): unknown =>
  (
    teamsApi.saveTeamOverlay.mock.lastCall![0] as {
      saveTeamOverlayDto: { overlay: { members: Record<string, unknown> } };
    }
  ).saveTeamOverlayDto.overlay.members.lead;

describe('ProjectTeamOverrides — the MCP allow list', () => {
  it('overrides a team without a list with the servers that load now', async () => {
    await mountWith({}, {});
    await press('Only servers I pick');
    expect(savedLead()).toEqual({ mcpAllowed: ['codegraph', 'linear'] });
  });

  it('overrides the team’s list with null for every server in this project', async () => {
    await mountWith({ mcpAllowed: ['codegraph'] }, {});
    expect(document.body.textContent).toContain('Only servers I pick');
    await press('All servers');
    expect(savedLead()).toEqual({ mcpAllowed: null });
  });

  it('marks an override, names the team’s value and resets to the team’s list', async () => {
    await mountWith(
      { mcpAllowed: ['codegraph'] },
      { members: { lead: { mcpAllowed: null } } },
    );
    expect(document.body.textContent).toContain('Team: only codegraph');
    await press('Reset Loads to the team');
    expect(savedLead()).toBeUndefined();
  });
});
