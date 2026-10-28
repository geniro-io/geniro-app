import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { EntityManager } from '@mikro-orm/sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { freshVocabularyStore } from '../../agents/adapters/__tests__/fresh-vocabulary-store';
import { ClaudeAdapter } from '../../agents/adapters/claude/claude.adapter';
import { CodexAdapter } from '../../agents/adapters/codex/codex.adapter';
import { CursorAcpAdapter } from '../../agents/adapters/cursor-acp/cursor-acp.adapter';
import type { ItemDao } from '../../agents/dao/item.dao';
import { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import type { Workflow } from '../graphs.types';
import { configDirToken } from '../utils/config-dir-redaction';
import { WORKFLOW_BACKUP_DIR } from '../utils/workflow-backup';
import { workflowSnapshotOf } from '../utils/workflow-snapshot';
import { InstructionSizesService } from './instruction-sizes.service';
import {
  type WorkflowChange,
  type WorkflowChangeAuthority,
  WorkflowChangeService,
} from './workflow-change.service';
import { WorkflowStoreService } from './workflow-store.service';

const WF: Workflow = {
  name: 'Dev Team',
  nodes: [
    { id: 'builder', kind: 'agent', agent: 'claude', approval: 'auto' },
    { id: 'reviewer', kind: 'agent', agent: 'claude', approval: 'auto' },
  ],
  edges: [{ from: 'builder', to: 'reviewer', kind: 'data' as const }],
};

const FASTER: Workflow = {
  ...WF,
  nodes: [
    WF.nodes[0]!,
    { ...WF.nodes[1]!, model: 'sonnet' } as Workflow['nodes'][number],
  ],
};

describe('WorkflowChangeService', () => {
  let dir: string;
  let store: WorkflowStoreService;
  let applies: unknown[];
  let service: WorkflowChangeService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'geniro-change-'));
    store = new WorkflowStoreService({ workflowsDir: dir });
    await store.create(WF, 'dev-team');
    applies = [{ cardSeq: 3, ids: ['W-1', 'W-2'] }];
    service = new WorkflowChangeService(
      { fork: () => ({}) } as unknown as EntityManager,
      store,
      {
        userMessagesInOrder: () =>
          Promise.resolve([
            { seq: 0, payload: JSON.stringify({ text: 'analyse' }) },
            ...applies.map((apply, index) => ({
              seq: index + 1,
              payload: JSON.stringify({ text: 'apply', apply }),
            })),
          ]),
      } as unknown as ItemDao,
      {
        for: (agent: string) => ({
          userInstructionsFile: (configDir: string | null) => ({
            path: `${configDir ?? `home-of-${agent}`}/RULES.md`,
          }),
        }),
      } as unknown as AgentAdapterRegistry,
      new InstructionSizesService(
        new AgentAdapterRegistry([
          new ClaudeAdapter(),
          new CursorAcpAdapter({ vocabularyStore: freshVocabularyStore() }),
          new CodexAdapter({ clientVersion: '1.0.0' }),
        ]),
      ),
    );
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function hash(): Promise<string> {
    return (await service.describe('dev-team', null)).hash as string;
  }

  /**
   * An analysis's save of `ids` (default W-1) against `baseHash` (default the
   * file as it stands), unless `authority` is given.
   */
  async function change(
    overrides: Partial<WorkflowChange> & {
      ids?: string[];
      baseHash?: string;
    } = {},
  ): Promise<Record<string, unknown>> {
    const { ids = ['W-1'], baseHash, authority, ...rest } = overrides;
    const asked: WorkflowChangeAuthority = authority ?? {
      kind: 'apply',
      analysisRunId: 'analysis',
      ids,
      baseHash: baseHash ?? (await hash()),
    };
    return service.save({
      authority: asked,
      slug: 'dev-team',
      edits: [{ path: 'nodes/reviewer/model', value: 'sonnet' }],
      dryRun: false,
      ...rest,
    });
  }

  /** A builder turn that began now and has not saved yet. */
  const builder = (
    turn: Partial<
      Omit<Extract<WorkflowChangeAuthority, { kind: 'builder' }>, 'kind'>
    > = {},
  ): WorkflowChangeAuthority => ({
    kind: 'builder',
    savedHash: null,
    turnStartedAt: Date.now(),
    acceptsAnyVersion: false,
    ...turn,
  });

  it('backs the file up before saving, and the backup is never listed as a workflow', async () => {
    const before = await readFile(join(dir, 'dev-team.geniro.yaml'), 'utf8');

    const result = await change();

    expect(result).toMatchObject({ saved: true });
    expect(result.hash).toBe(await hash());
    const backups = await readdir(join(dir, WORKFLOW_BACKUP_DIR));
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(
      /^dev-team\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.yaml$/,
    );
    expect(result.backup).toBe(`${WORKFLOW_BACKUP_DIR}/${backups[0]}`);
    expect(
      await readFile(join(dir, WORKFLOW_BACKUP_DIR, backups[0]!), 'utf8'),
    ).toBe(before);
    expect((await store.get('dev-team')).workflow.nodes[1]).toMatchObject({
      model: 'sonnet',
    });
    expect((await store.list()).map((entry) => entry.slug)).toEqual([
      'dev-team',
    ]);
  });

  it('refuses an id that is not in the latest Apply, even one an earlier Apply named', async () => {
    applies = [
      { cardSeq: 3, ids: ['W-1'] },
      { cardSeq: 3, ids: ['W-2'] },
    ];

    expect(await change({ ids: ['W-1'] })).toMatchObject({
      saved: false,
      error: 'NOT_SELECTED',
    });
    applies = [];
    expect(await change()).toMatchObject({ error: 'NOT_APPLIED' });
  });

  it('refuses a repo or user item even when the user applied it', async () => {
    applies = [{ cardSeq: 3, ids: ['R-1', 'U-1'] }];

    expect(await change({ ids: ['R-1'] })).toMatchObject({
      saved: false,
      error: 'NOT_A_WORKFLOW_ITEM',
    });
    expect(await change({ ids: ['U-1'] })).toMatchObject({
      saved: false,
      error: 'NOT_A_WORKFLOW_ITEM',
    });
  });

  it('refuses a save on a copy that changed since it was read', async () => {
    const baseHash = await hash();
    await store.save('dev-team', { ...WF, description: 'edited by hand' });

    const result = await change({ baseHash });

    expect(result).toMatchObject({ saved: false, error: 'HASH_DRIFT' });
    expect(result.currentHash).toBe(await hash());
  });

  it('refuses with HASH_DRIFT, keeping the other write, when the file changes while saving', async () => {
    const realSave = store.save.bind(store);
    let first = true;
    store.save = async (slug, workflow, baseHash) => {
      if (first) {
        first = false;
        // A canvas autosave lands between the service's check and its write.
        await realSave(slug, { ...WF, description: 'builder autosave' });
      }
      return realSave(slug, workflow, baseHash);
    };

    const result = await change();

    expect(result).toMatchObject({ saved: false, error: 'HASH_DRIFT' });
    expect(typeof result.backup).toBe('string');
    expect((await store.get('dev-team')).workflow.description).toBe(
      'builder autosave',
    );
  });

  it('refuses a workflow whose file was deleted, rather than re-creating it', async () => {
    const baseHash = await hash();
    await store.delete('dev-team');

    expect(await change({ baseHash })).toMatchObject({
      error: 'WORKFLOW_GONE',
    });
    await expect(readdir(dir)).resolves.not.toContain('dev-team.geniro.yaml');
  });

  it('refuses an invalid graph and writes nothing', async () => {
    const result = await change({
      edits: [
        {
          path: 'edges/-',
          value: { from: 'reviewer', to: 'builder', kind: 'data' },
        },
      ],
    });

    expect(result).toMatchObject({ saved: false, error: 'INVALID_WORKFLOW' });
    await expect(readdir(dir)).resolves.not.toContain(WORKFLOW_BACKUP_DIR);
  });

  it('refuses an edit that does not apply and writes nothing', async () => {
    const result = await change({
      edits: [{ find: 'not in the workflow', replace: 'x' }],
    });

    expect(result).toMatchObject({ saved: false, error: 'INVALID_EDIT' });
    expect(result.message).toMatch(/^edit 1: `find` matches no text/);
    expect((await store.get('dev-team')).workflow).toEqual(WF);
    await expect(readdir(dir)).resolves.not.toContain(WORKFLOW_BACKUP_DIR);
  });

  it('changes text inside a string value without the agent sending the rest', async () => {
    await store.save('dev-team', {
      ...WF,
      description: 'Builds, then reviews. Slow on purpose.',
    });

    const result = await change({
      edits: [{ find: ' Slow on purpose.', replace: '' }],
    });

    expect(result).toMatchObject({ saved: true });
    expect((await store.get('dev-team')).workflow).toEqual({
      ...WF,
      description: 'Builds, then reviews.',
    });
  });

  it('answers the diff on a dry run and writes nothing', async () => {
    const result = await change({ dryRun: true });

    expect(result).toMatchObject({
      dryRun: true,
      saved: false,
      diff: { changedNodes: [{ id: 'reviewer' }] },
    });
    expect((await store.get('dev-team')).workflow).toEqual(WF);
    await expect(readdir(dir)).resolves.not.toContain(WORKFLOW_BACKUP_DIR);
  });

  describe('from a builder chat', () => {
    const PROFILE = '/Users/someone/.claude-work';
    const PROFILED: Workflow = {
      ...WF,
      nodes: [
        { ...WF.nodes[0]!, configDir: PROFILE } as Workflow['nodes'][number],
        WF.nodes[1]!,
      ],
    };

    it('saves with no Apply and no hash behind it, and takes no backup of its own', async () => {
      applies = [];

      const result = await change({ authority: builder() });

      expect(result).toMatchObject({ saved: true });
      expect(result.hash).toBe(await hash());
      expect(result).not.toHaveProperty('backup');
      await expect(readdir(dir)).resolves.not.toContain(WORKFLOW_BACKUP_DIR);
      expect((await store.get('dev-team')).workflow.nodes[1]).toMatchObject({
        model: 'sonnet',
      });
    });

    it('refuses a file written after its turn began, before its first save', async () => {
      const result = await change({ authority: builder({ turnStartedAt: 0 }) });

      expect(result).toMatchObject({ saved: false, error: 'HASH_DRIFT' });
      expect(result.message).toMatch(/read the file again/);
      expect(result.currentHash).toBe(await hash());
      expect((await store.get('dev-team')).workflow).toEqual(WF);
    });

    it("counts a write in the turn's first millisecond as before it, and one a millisecond later as after", async () => {
      const written = Math.floor(
        (await stat(join(dir, 'dev-team.geniro.yaml'))).mtimeMs,
      );

      expect(
        await change({
          authority: builder({ turnStartedAt: written - 1 }),
          dryRun: true,
        }),
      ).toMatchObject({ error: 'HASH_DRIFT' });
      expect(
        await change({
          authority: builder({ turnStartedAt: written }),
          dryRun: true,
        }),
      ).toMatchObject({ dryRun: true, saved: false });
    });

    it('reports the version it lost a race to, so the next save can settle', async () => {
      const realSave = store.save.bind(store);
      let first = true;
      store.save = async (slug, workflow, baseHash) => {
        if (first) {
          first = false;
          await realSave(slug, { ...WF, description: 'canvas edit' });
        }
        return realSave(slug, workflow, baseHash);
      };

      const result = await change({ authority: builder() });

      expect(result).toMatchObject({ saved: false, error: 'HASH_DRIFT' });
      expect(result.currentHash).toBe(await hash());
    });

    it('stays a refusal when the write it lost to left a file that does not parse', async () => {
      const realSave = store.save.bind(store);
      store.save = async (slug, workflow, baseHash) => {
        await writeFile(join(dir, 'dev-team.geniro.yaml'), 'nodes: [\n');
        return realSave(slug, workflow, baseHash);
      };

      const result = await change({ authority: builder() });

      expect(result).toMatchObject({ saved: false, error: 'HASH_DRIFT' });
      expect(typeof result.currentHash).toBe('string');
    });

    it('checks a later save against the version the turn last knew, not the turn start', async () => {
      const known = await hash();

      expect(
        await change({
          authority: builder({ savedHash: known, turnStartedAt: 0 }),
        }),
      ).toMatchObject({ saved: true });
      expect(
        await change({
          authority: builder({ savedHash: known }),
          edits: [{ path: 'nodes/reviewer/model', value: 'opus' }],
        }),
      ).toMatchObject({ saved: false, error: 'HASH_DRIFT' });
    });

    it('points a find that matches nothing at the file, not at an analysis view', async () => {
      const result = await change({
        authority: builder(),
        edits: [{ find: 'not in the workflow', replace: 'x' }],
      });

      expect(result).toMatchObject({ saved: false, error: 'INVALID_EDIT' });
      expect(result.message).toMatch(/copy it exactly from the workflow file/);
    });

    it('refuses a file that no longer parses, naming the fault but quoting no line of it', async () => {
      await writeFile(
        join(dir, 'dev-team.geniro.yaml'),
        'name: Dev Team\nnodes:\n  - id: a\n    configDir: /Users/someone/.claude-work\n      bad: indent\n',
      );

      const result = await change({
        authority: builder({ turnStartedAt: Date.now() + 60_000 }),
      });

      expect(result).toMatchObject({
        saved: false,
        error: 'WORKFLOW_UNREADABLE',
      });
      expect(result.message).toMatch(/fix only what this names/);
      expect(result.message).not.toContain('.claude-work');
    });

    it('names the version it checked on every answer past the check, so a repair is pinned', async () => {
      const repaired = builder({ turnStartedAt: 0, acceptsAnyVersion: true });

      for (const result of [
        await change({ authority: repaired, dryRun: true }),
        await change({
          authority: repaired,
          edits: [{ find: 'not in the workflow', replace: 'x' }],
        }),
        await change({
          authority: repaired,
          edits: [{ path: 'nodes/reviewer/model', value: undefined }],
        }),
      ]) {
        expect(result.currentHash).toBe(await hash());
      }
    });

    it('takes the file as it stands after the agent repaired one it could not load', async () => {
      const result = await change({
        authority: builder({
          savedHash: 'before-the-repair',
          turnStartedAt: 0,
          acceptsAnyVersion: true,
        }),
      });

      expect(result).toMatchObject({ saved: true });
    });

    it('refuses an invalid graph and writes nothing', async () => {
      const result = await change({
        authority: builder(),
        edits: [
          {
            path: 'edges/-',
            value: { from: 'reviewer', to: 'builder', kind: 'data' },
          },
        ],
      });

      expect(result).toMatchObject({ saved: false, error: 'INVALID_WORKFLOW' });
      await expect(readdir(dir)).resolves.not.toContain(WORKFLOW_BACKUP_DIR);
    });

    it('puts back a profile it wrote as the token read_workflows showed', async () => {
      await store.save('dev-team', PROFILED);
      const node = {
        ...WF.nodes[0]!,
        configDir: configDirToken(PROFILE),
        model: 'opus',
      };

      const result = await change({
        authority: builder({ savedHash: await hash() }),
        edits: [{ path: 'nodes/builder', value: node }],
      });

      expect(result).toMatchObject({ saved: true });
      expect((await store.get('dev-team')).workflow.nodes[0]).toMatchObject({
        configDir: PROFILE,
        model: 'opus',
      });
    });

    it('refuses a token that names no profile of this workflow, and writes nothing', async () => {
      const result = await change({
        authority: builder(),
        edits: [
          {
            path: 'nodes/builder/configDir',
            value: configDirToken('/elsewhere'),
          },
        ],
      });

      expect(result).toMatchObject({
        saved: false,
        error: 'CONFIG_DIR_UNKNOWN',
      });
      expect((await store.get('dev-team')).workflow).toEqual(WF);
    });
  });

  it('backs the file up as it stands when asked, and refuses a deleted workflow', async () => {
    const before = await readFile(join(dir, 'dev-team.geniro.yaml'), 'utf8');

    const result = await service.backUp('dev-team');

    const backups = await readdir(join(dir, WORKFLOW_BACKUP_DIR));
    expect(result).toEqual({
      backedUp: true,
      backup: `${WORKFLOW_BACKUP_DIR}/${backups[0]}`,
    });
    expect(
      await readFile(join(dir, WORKFLOW_BACKUP_DIR, backups[0]!), 'utf8'),
    ).toBe(before);
    await store.delete('dev-team');
    expect(await service.backUp('dev-team')).toMatchObject({
      error: 'WORKFLOW_GONE',
    });
  });

  it('answers the backup it already has for an unchanged file, and copies a changed one', async () => {
    const first = await service.backUp('dev-team');

    expect(await service.backUp('dev-team')).toEqual({
      backedUp: true,
      backup: first.backup,
      unchangedSinceThatBackup: true,
    });
    expect(await readdir(join(dir, WORKFLOW_BACKUP_DIR))).toHaveLength(1);

    await store.save('dev-team', FASTER);
    const changed = await service.backUp('dev-team');

    expect(changed.backup).not.toBe(first.backup);
    expect(changed).not.toHaveProperty('unchangedSinceThatBackup');
    expect(await readdir(join(dir, WORKFLOW_BACKUP_DIR))).toHaveLength(2);
  });

  it("describes the library copy against the run's own snapshot", async () => {
    await writeFile(join(dir, 'unrelated.txt'), 'x');
    const described = await service.describe(
      'dev-team',
      workflowSnapshotOf(FASTER),
    );

    expect(described).toMatchObject({
      slug: 'dev-team',
      workflow: WF,
      changedSinceThisRun: { changedNodes: [{ id: 'reviewer' }] },
    });
    expect(typeof described.hash).toBe('string');
  });

  it('lists the instructions file of every agent and pool member the run itself ran', async () => {
    const ran: Workflow = {
      ...WF,
      nodes: [
        WF.nodes[0]!,
        {
          ...WF.nodes[1]!,
          agent: 'codex',
          pool: [{ agent: 'claude', configDir: '/profiles/work' }],
        } as Workflow['nodes'][number],
      ],
    };

    const described = await service.describe(
      'dev-team',
      workflowSnapshotOf(ran),
    );

    const unmeasured = { exists: false, chars: null, approxTokens: null };
    expect(described.userInstructions).toEqual([
      {
        agent: 'claude',
        configDir: null,
        path: 'home-of-claude/RULES.md',
        ...unmeasured,
      },
      {
        agent: 'codex',
        configDir: null,
        path: 'home-of-codex/RULES.md',
        ...unmeasured,
      },
      {
        agent: 'claude',
        configDir: '/profiles/work',
        path: '/profiles/work/RULES.md',
        ...unmeasured,
      },
    ]);
  });

  it("measures every agent's always-on instructions as the library composes them, with the run's own settings and card", async () => {
    const roles: Workflow = {
      ...WF,
      nodes: [
        { ...WF.nodes[0]!, role: 'Build it.' } as Workflow['nodes'][number],
        {
          ...WF.nodes[1]!,
          role: 'Review it.',
        } as Workflow['nodes'][number],
      ],
    };
    await store.save('dev-team', roles);
    const ran: Workflow = {
      ...roles,
      nodes: [
        roles.nodes[0]!,
        {
          ...roles.nodes[1]!,
          role: `Review it. ${'Be thorough. '.repeat(50)}`,
        } as Workflow['nodes'][number],
      ],
    };

    const described = await service.describe(
      'dev-team',
      workflowSnapshotOf(ran),
      {
        customInstructions: 'MINE',
        replyLanguage: null,
        taskInstructions: 'CARD',
      },
    );
    const sizes = described.instructionSizes as {
      nodeId: string;
      totalChars: number;
      approxTokens: number;
      parts: { source: string; chars: number }[];
      inThisRun?: { totalChars: number; approxTokens: number };
    }[];

    expect(sizes.map((node) => node.nodeId)).toEqual(['builder', 'reviewer']);
    const [builder, reviewer] = sizes;
    expect(builder!.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'customInstructions', chars: 4 }),
        expect.objectContaining({ source: 'taskInstructions', chars: 4 }),
        expect.objectContaining({ source: 'role', chars: 9 }),
      ]),
    );
    expect(builder!.parts.map((part) => part.source)).not.toContain(
      'replyLanguage',
    );
    expect(builder).not.toHaveProperty('inThisRun');
    // The run paid for the longer role it started with.
    expect(reviewer!.inThisRun!.totalChars).toBe(
      reviewer!.totalChars + 'Be thorough. '.repeat(50).trim().length + 1,
    );
  });

  it('measures each user-instructions file as it stands now', async () => {
    await writeFile(join(dir, 'RULES.md'), 'x'.repeat(41));
    const sized = new WorkflowChangeService(
      { fork: () => ({}) } as unknown as EntityManager,
      store,
      {} as ItemDao,
      {
        for: () => ({
          userInstructionsFile: () => ({ path: join(dir, 'RULES.md') }),
        }),
      } as unknown as AgentAdapterRegistry,
      new InstructionSizesService(
        new AgentAdapterRegistry([new ClaudeAdapter()]),
      ),
    );

    const described = await sized.describe('dev-team', null);

    expect(described.userInstructions).toEqual([
      expect.objectContaining({ exists: true, chars: 41, approxTokens: 11 }),
    ]);
  });
});
