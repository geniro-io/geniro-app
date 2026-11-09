import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NotFoundException } from '@packages/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RunWire } from '../../agents/chat.types';
import type { ChatService } from '../../agents/services/chat.service';
import type { ProjectDao } from '../../projects/dao/project.dao';
import type { ProjectWire } from '../../projects/projects.types';
import { ProjectEventBus } from '../../projects/services/project-events.bus';
import type { ProjectsService } from '../../projects/services/projects.service';
import { member, teamOf } from '../__tests__/team-builders';
import type { StartProjectChatInput } from '../teams.types';
import { ProjectChatService } from './project-chat.service';
import { TeamOverlayService } from './team-overlay.service';
import { TeamOverlayStoreService } from './team-overlay-store.service';
import { TeamStoreService } from './team-store.service';

const CHIPS: StartProjectChatInput = {
  agentKind: 'claude',
  approval: 'acceptEdits',
};

function runWire(id: string, cwd: string | null = null): RunWire {
  return { id, cwd } as RunWire;
}

describe('ProjectChatService', () => {
  let dir: string;
  let folder: string;
  let store: TeamStoreService;
  let overlays: TeamOverlayStoreService;
  let project: ProjectWire | null;
  let events: ProjectEventBus;
  let chats: {
    findProjectChat: ReturnType<typeof vi.fn>;
    createChat: ReturnType<typeof vi.fn>;
    refreshTeamInstructions: ReturnType<typeof vi.fn>;
    deleteProjectChats: ReturnType<typeof vi.fn>;
    projectChatProjectIds: ReturnType<typeof vi.fn>;
    offeredApproval: ReturnType<typeof vi.fn>;
    useProjectChat: ReturnType<typeof vi.fn>;
  };
  let service: ProjectChatService;

  const brief = (): string => {
    const [input] = chats.createChat.mock.calls[0] as [
      Parameters<ChatService['createChat']>[0],
    ];
    return input.teamInstructions ?? '';
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'geniro-project-chat-'));
    folder = await mkdtemp(join(tmpdir(), 'geniro-project-folder-'));
    store = new TeamStoreService({ teamsDir: dir });
    overlays = new TeamOverlayStoreService({ teamsDir: dir });
    project = {
      id: 'p1',
      name: 'Billing',
      folder,
      description: 'The billing service.',
      instructionBlocks: [{ id: 'b1', title: 'Build', text: 'Use pnpm.' }],
      instructionsRevision: 3,
      agentKind: 'codex',
      teamSlug: null,
    } as unknown as ProjectWire;
    events = new ProjectEventBus();
    chats = {
      findProjectChat: vi.fn().mockResolvedValue(null),
      createChat: vi.fn().mockResolvedValue(runWire('new-run')),
      refreshTeamInstructions: vi.fn().mockResolvedValue(undefined),
      deleteProjectChats: vi.fn().mockResolvedValue({ deleted: 1 }),
      projectChatProjectIds: vi.fn().mockResolvedValue([]),
      offeredApproval: vi.fn(
        (_kind: string, approval: string | undefined) => approval,
      ),
      useProjectChat: vi.fn(),
    };
    const projects = {
      get: async (id: string) => {
        if (project === null || id !== project.id) {
          throw new NotFoundException('PROJECT_NOT_FOUND', 'gone');
        }
        return project;
      },
    };
    const projectDao = {
      getById: async (id: string) =>
        project !== null && id === project.id ? project : null,
      listAll: async () => (project === null ? [] : [project]),
    };
    service = new ProjectChatService(
      chats as unknown as ChatService,
      projects as unknown as ProjectsService,
      store,
      new TeamOverlayService(
        overlays,
        store,
        projectDao as unknown as ProjectDao,
        { fork: () => ({}) } as never,
      ),
      events,
    );
    service.onModuleInit();
  });

  afterEach(async () => {
    service.onModuleDestroy();
    await rm(dir, { recursive: true, force: true });
    await rm(folder, { recursive: true, force: true });
  });

  it('opens a hidden chat in the project’s folder, under the project, briefed on its blocks', async () => {
    await service.open('p1', CHIPS);

    const [input] = chats.createChat.mock.calls[0] as [
      Parameters<ChatService['createChat']>[0],
    ];
    expect(input).toMatchObject({
      cwd: folder,
      projectId: 'p1',
      editsProjectId: 'p1',
      title: 'Project: Billing',
      agentKind: 'claude',
      approval: 'acceptEdits',
    });
    expect(input.editsTeamSlug).toBeUndefined();
    expect(brief()).toContain('<project-instructions revision="3">');
    expect(brief()).toContain('"text": "Use pnpm."');
    expect(brief()).toContain('The billing service.');
    expect(brief()).toContain('the codex agent');
    expect(brief()).not.toContain('ITS TEAM');
  });

  it('briefs a team-run project on its team’s members and its overlay', async () => {
    const { slug } = await store.create(
      teamOf(
        [
          member('lead', {
            model: 'opus',
            pool: [{ agent: 'codex', model: 'gpt-5' }],
          }),
        ],
        { name: 'Dev Team' },
      ),
    );
    project = { ...project!, teamSlug: slug };
    await overlays.save(slug, 'p1', {
      members: { lead: { settings: { effort: 'max' } } },
    });

    await service.open('p1', CHIPS);

    expect(brief()).toContain('ITS TEAM');
    expect(brief()).toContain('with read_teams');
    expect(brief()).not.toContain(store.locate(slug).path);
    expect(brief()).toContain(overlays.pathOf(slug, 'p1'));
    expect(brief()).toContain('effort: max');
    expect(brief()).toMatch(/model: gpt-5/);
  });

  it('tells a project that defaults to an agent that any team or project is within reach', async () => {
    await service.open('p1', CHIPS);

    expect(brief()).toContain('CHANGING ANY TEAM OR PROJECT');
    expect(brief()).toContain('`replaces` (its slug)');
    expect(brief()).toContain('`overlayProjectId`');
    expect(brief()).toContain('`projectId`');
  });

  it('tells a team-run project how to change its team, and never that the team is out of reach', async () => {
    const { slug } = await store.create(
      teamOf([member('lead')], { name: 'Dev Team' }),
    );
    project = { ...project!, teamSlug: slug };

    await service.open('p1', CHIPS);

    expect(brief()).toContain('CHANGING ANY TEAM OR PROJECT');
    expect(brief()).toContain('`replaces` set to that slug');
    expect(brief()).not.toContain('you cannot change it. Read it');
    expect(brief()).not.toContain('never here');
  });

  it('re-briefs the open chat instead of starting a second one', async () => {
    chats.findProjectChat.mockResolvedValue(runWire('existing', folder));

    await expect(service.open('p1', CHIPS)).resolves.toEqual(
      runWire('existing', folder),
    );

    expect(chats.createChat).not.toHaveBeenCalled();
    expect(chats.refreshTeamInstructions).toHaveBeenCalledWith(
      'existing',
      expect.stringContaining('<project-instructions revision="3">'),
    );
  });

  it('deletes the chat with its project, and keeps it while the project stands', async () => {
    events.publish({ projectId: 'p1' });
    await Promise.resolve();
    project = null;
    events.publish({ projectId: 'p1' });

    await vi.waitFor(() =>
      expect(chats.deleteProjectChats).toHaveBeenCalledWith('p1'),
    );
    expect(chats.deleteProjectChats).toHaveBeenCalledTimes(1);
  });

  it('sweeps the chat of a project deleted while the daemon was down', async () => {
    chats.projectChatProjectIds.mockResolvedValue(['p1', 'p-gone']);

    service.onApplicationBootstrap();

    await vi.waitFor(() =>
      expect(chats.deleteProjectChats).toHaveBeenCalledWith('p-gone'),
    );
    expect(chats.deleteProjectChats).not.toHaveBeenCalledWith('p1');
  });
});
