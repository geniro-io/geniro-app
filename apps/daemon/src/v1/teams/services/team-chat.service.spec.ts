import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NotFoundException } from '@packages/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RunWire } from '../../agents/chat.types';
import type { ChatService } from '../../agents/services/chat.service';
import type { ThreadAnalysisService } from '../../agents/services/thread-analysis.service';
import type { MemoryService } from '../../memory/services/memory.service';
import type { StartTeamChatInput, Team } from '../teams.types';
import { teamJsonSchema } from '../utils/team-json-schema';
import { TeamChatService } from './team-chat.service';
import { TeamStoreService } from './team-store.service';

const WF: Team = {
  name: 'Dev Team',
  nodes: [{ id: 'start', kind: 'trigger', trigger: 'manual' }],
  edges: [],
};

const CHIPS: StartTeamChatInput = {
  agentKind: 'claude',
  model: 'opus',
  approval: 'acceptEdits',
};

function runWire(id: string): RunWire {
  return { id } as RunWire;
}

describe('TeamChatService', () => {
  let dir: string;
  let store: TeamStoreService;
  let chats: {
    findTeamChat: ReturnType<typeof vi.fn>;
    createChat: ReturnType<typeof vi.fn>;
    refreshTeamInstructions: ReturnType<typeof vi.fn>;
    useTeamBrief: ReturnType<typeof vi.fn>;
    deleteTeamChats: ReturnType<typeof vi.fn>;
    offeredApproval: ReturnType<typeof vi.fn>;
  };
  let analyses: { deleteTeamAnalyses: ReturnType<typeof vi.fn> };
  let service: TeamChatService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'geniro-team-chat-'));
    store = new TeamStoreService({ teamsDir: dir });
    chats = {
      findTeamChat: vi.fn().mockResolvedValue(null),
      createChat: vi.fn().mockResolvedValue(runWire('new-run')),
      refreshTeamInstructions: vi.fn().mockResolvedValue(undefined),
      useTeamBrief: vi.fn(),
      deleteTeamChats: vi.fn().mockResolvedValue({ deleted: 2 }),
      offeredApproval: vi.fn(
        (_kind: string, approval: string | undefined) => approval,
      ),
    };
    analyses = { deleteTeamAnalyses: vi.fn().mockResolvedValue(undefined) };
    service = new TeamChatService(
      store,
      chats as unknown as ChatService,
      analyses as unknown as ThreadAnalysisService,
      { enabled: true } as MemoryService,
    );
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('opens the chat in the library directory, pointed at the team file', async () => {
    const { slug } = await store.create(WF);

    await service.open(slug, CHIPS);

    const [input] = chats.createChat.mock.calls[0] as [
      Parameters<ChatService['createChat']>[0],
    ];
    expect(input.cwd).toBe(dir);
    expect(input.editsTeamSlug).toBe(slug);
    expect(input.teamInstructions).toContain(join(dir, `${slug}.team.yaml`));
    expect(input.teamInstructions).toContain(`slug \`${slug}\``);
  });

  it('writes the generated schema beside the teams and points the brief at it', async () => {
    const { slug } = await store.create(WF);

    await service.open(slug, CHIPS);

    const [input] = chats.createChat.mock.calls[0] as [
      Parameters<ChatService['createChat']>[0],
    ];
    const schemaPath = join(dir, '.team.schema.json');
    expect(input.teamInstructions).toContain(schemaPath);
    expect(await readFile(schemaPath, 'utf8')).toBe(teamJsonSchema());
    // A dotfile beside the teams must not appear as a library entry.
    expect((await store.list()).map((entry) => entry.slug)).toEqual([slug]);
  });

  it('carries the composer chips through to the chat', async () => {
    const { slug } = await store.create(WF);

    await service.open(slug, CHIPS);

    const [input] = chats.createChat.mock.calls[0] as [
      Parameters<ChatService['createChat']>[0],
    ];
    expect(input.agentKind).toBe('claude');
    expect(input.model).toBe('opus');
    expect(input.approval).toBe('acceptEdits');
  });

  it('opens on the CLI’s own default when the dock’s mode is one it does not offer', async () => {
    // The dock defaults to acceptEdits, which cursor does not offer; refusing
    // it would leave a cursor builder chat that cannot open at all.
    const { slug } = await store.create(WF);
    chats.offeredApproval.mockReturnValue(undefined);

    await service.open(slug, { ...CHIPS, agentKind: 'cursor-agent' });

    expect(chats.offeredApproval).toHaveBeenCalledWith(
      'cursor-agent',
      'acceptEdits',
    );
    const [input] = chats.createChat.mock.calls[0] as [
      Parameters<ChatService['createChat']>[0],
    ];
    expect(input.approval).toBeUndefined();
  });

  it('titles the thread after the team, so it is findable in the sidebar', async () => {
    const { slug } = await store.create(WF);

    await service.open(slug, CHIPS);

    const [input] = chats.createChat.mock.calls[0] as [
      Parameters<ChatService['createChat']>[0],
    ];
    expect(input.title).toBe('Team: Dev Team');
  });

  // The panel is somewhere the user comes back to, so a second press must find
  // yesterday's conversation rather than strand it behind a fresh one.
  it('returns the existing chat and creates nothing when one is already open', async () => {
    const { slug } = await store.create(WF);
    chats.findTeamChat.mockResolvedValue(runWire('existing-run'));

    await expect(service.open(slug, CHIPS)).resolves.toEqual(
      runWire('existing-run'),
    );
    expect(chats.createChat).not.toHaveBeenCalled();
  });

  // Otherwise a conversation opened before an update, or before the team
  // was renamed, stays briefed on the old format and the old name for good.
  it('re-briefs an existing chat with the current team name', async () => {
    const { slug } = await store.create(WF);
    await store.save(slug, { ...WF, name: 'Review Team' });
    chats.findTeamChat.mockResolvedValue(runWire('existing-run'));

    await service.open(slug, CHIPS);

    expect(chats.refreshTeamInstructions).toHaveBeenCalledWith(
      'existing-run',
      expect.stringContaining('"Review Team"'),
    );
  });

  it('hands the chat service the brief of the team as it stands, for every turn of a builder chat', async () => {
    const { slug } = await store.create(WF);
    service.onModuleInit();
    const source = chats.useTeamBrief.mock.calls[0]?.[0] as (
      slug: string,
      cwd: string,
    ) => Promise<string>;
    await store.save(slug, { ...WF, name: 'Review Team' });

    const brief = await source(slug, dir);

    expect(brief).toContain('"Review Team"');
    expect(brief).toContain(join(dir, `${slug}.team.yaml`));
    expect(brief).toContain('Its directory is\nyour working directory');
  });

  it('tells a chat opened before the library moved where the library is now', async () => {
    const { slug } = await store.create(WF);
    service.onModuleInit();
    const source = chats.useTeamBrief.mock.calls[0]?.[0] as (
      slug: string,
      cwd: string,
    ) => Promise<string>;
    const legacy = await mkdtemp(join(tmpdir(), 'geniro-legacy-library-'));
    try {
      const brief = await source(slug, legacy);

      expect(brief).not.toContain('your working directory');
      expect(brief).toContain(`Its directory,\n${dir}, holds`);
    } finally {
      await rm(legacy, { recursive: true, force: true });
    }
  });

  it('still briefs a chat whose team file no longer parses, so it can repair it', async () => {
    const { slug } = await store.create(WF);
    service.onModuleInit();
    const source = chats.useTeamBrief.mock.calls[0]?.[0] as (
      slug: string,
      cwd: string,
    ) => Promise<string>;
    await writeFile(join(dir, `${slug}.team.yaml`), 'nodes: [', 'utf8');

    const brief = await source(slug, dir);

    expect(brief).toContain(`"${slug}"`);
    expect(brief).toContain(join(dir, `${slug}.team.yaml`));
  });

  it('keeps the name a team file states when only the schema refuses it, so the brief does not change', async () => {
    const { slug } = await store.create(WF);
    service.onModuleInit();
    const source = chats.useTeamBrief.mock.calls[0]?.[0] as (
      slug: string,
      cwd: string,
    ) => Promise<string>;
    const before = await source(slug, dir);
    await writeFile(
      join(dir, `${slug}.team.yaml`),
      'name: Dev Team\nnodes: 5\n',
      'utf8',
    );

    expect(await source(slug, dir)).toBe(before);
  });

  it('rewrites the schema reference when it has gone since it was written', async () => {
    const { slug } = await store.create(WF);
    service.onModuleInit();
    const source = chats.useTeamBrief.mock.calls[0]?.[0] as (
      slug: string,
      cwd: string,
    ) => Promise<string>;
    await source(slug, dir);
    await rm(join(dir, '.team.schema.json'));

    await source(slug, dir);

    expect(await readFile(join(dir, '.team.schema.json'), 'utf8')).toContain(
      '"$schema"',
    );
  });

  it('keeps the stored brief of a chat whose team is gone', async () => {
    service.onModuleInit();
    const source = chats.useTeamBrief.mock.calls[0]?.[0] as (
      slug: string,
      cwd: string,
    ) => Promise<string>;

    await expect(source('gone', dir)).rejects.toBeInstanceOf(NotFoundException);
  });

  // Measured in the running app: React's development double-effect fired two
  // opens from one press, both found no chat, and both created one — two
  // conversations for one team, with the older stranded.
  it('creates ONE chat when two opens race for the same team', async () => {
    const { slug } = await store.create(WF);

    const [first, second] = await Promise.all([
      service.open(slug, CHIPS),
      service.open(slug, CHIPS),
    ]);

    expect(chats.createChat).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
  });

  it('opens again after the first one settled — the join is not a cache', async () => {
    const { slug } = await store.create(WF);
    await service.open(slug, CHIPS);
    chats.findTeamChat.mockResolvedValue(runWire('existing-run'));

    await expect(service.open(slug, CHIPS)).resolves.toEqual(
      runWire('existing-run'),
    );
  });

  it('retries after a failed open rather than handing back the failure', async () => {
    chats.findTeamChat.mockRejectedValueOnce(new Error('daemon down'));
    const { slug } = await store.create(WF);

    await expect(service.open(slug, CHIPS)).rejects.toThrow('daemon down');

    await expect(service.open(slug, CHIPS)).resolves.toEqual(
      runWire('new-run'),
    );
  });

  it('refuses a slug the library does not hold, without opening a chat', async () => {
    await expect(service.open('no-such-team', CHIPS)).rejects.toThrow(
      NotFoundException,
    );
    expect(chats.createChat).not.toHaveBeenCalled();
  });

  it('discards every chat about one team without reading the library', async () => {
    await expect(service.discard('already-deleted')).resolves.toEqual({
      deleted: 2,
    });
    expect(chats.deleteTeamChats).toHaveBeenCalledWith('already-deleted');
  });

  it('deletes a team, the chat about it and its analyses', async () => {
    const { slug } = await store.create(WF);

    await service.deleteTeam(slug);

    await expect(store.get(slug)).rejects.toThrow(NotFoundException);
    expect(chats.deleteTeamChats).toHaveBeenCalledWith(slug);
    expect(analyses.deleteTeamAnalyses).toHaveBeenCalledWith(slug);
  });

  // The file goes first, so a slug the library never held cannot take a
  // conversation with it.
  it('destroys no chat when the team was not there to delete', async () => {
    await expect(service.deleteTeam('no-such-team')).rejects.toThrow(
      NotFoundException,
    );
    expect(chats.deleteTeamChats).not.toHaveBeenCalled();
    expect(analyses.deleteTeamAnalyses).not.toHaveBeenCalled();
  });
});
