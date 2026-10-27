import { readFileSync } from 'node:fs';
import {
  chmod,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { EntityManager } from '@mikro-orm/sqlite';
import { BadRequestException } from '@packages/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  DeferredCard,
  DeferredCardResponder,
  WorkflowProposalOutcome,
} from '../../agents/chat.types';
import type { ItemDao } from '../../agents/dao/item.dao';
import type { RunDao } from '../../agents/dao/run.dao';
import { ApprovalRegistry } from '../../agents/services/approval-registry';
import type { ChatService } from '../../agents/services/chat.service';
import type { Workflow, WorkflowProposal } from '../graphs.types';
import {
  configDirToken,
  redactConfigDirs,
} from '../utils/config-dir-redaction';
import { WORKFLOW_BACKUP_DIR } from '../utils/workflow-backup';
import type { WorkflowEdit } from '../utils/workflow-edits';
import type { GraphExecutorService } from './graph-executor.service';
import { WorkflowProposalService } from './workflow-proposal.service';
import { WorkflowStoreService } from './workflow-store.service';

const TEAM: Workflow = {
  name: 'Review Team',
  nodes: [
    { id: 'start', kind: 'trigger', trigger: 'manual' },
    { id: 'coder', kind: 'agent', agent: 'claude', approval: 'ask' },
    { id: 'reviewer', kind: 'agent', agent: 'claude', approval: 'auto' },
  ],
  edges: [
    { from: 'start', to: 'coder', kind: 'data' },
    { from: 'coder', to: 'reviewer', kind: 'data' },
  ],
};

const FASTER: Workflow = {
  ...TEAM,
  nodes: TEAM.nodes.map((node) =>
    node.id === 'reviewer' ? { ...node, model: 'sonnet' } : node,
  ),
};

/** `Run.pendingWorkflowProposal` per run, and every write to it in order. */
class FakeRuns {
  readonly column = new Map<string, string | null>();
  readonly writes: { runId: string; value: string | null }[] = [];
  /** Set by a test to watch what was on disk at the moment of a write. */
  onWrite: ((value: string | null) => void) | null = null;
  /** Set by a test to make a write of this kind fail. */
  failWrite: ((value: string | null) => boolean) | null = null;
  /** Set by a test to hold a clear back until it is released. */
  holdClear: Promise<void> | null = null;

  getById(id: string): Promise<{ pendingWorkflowProposal: string | null }> {
    return Promise.resolve({
      pendingWorkflowProposal: this.column.get(id) ?? null,
    });
  }
  setPendingWorkflowProposal(id: string, value: string | null): Promise<void> {
    if (this.failWrite?.(value)) {
      return Promise.reject(new Error('SQLITE_BUSY: /private/geniro.db'));
    }
    const write = (): void => {
      this.onWrite?.(value);
      this.writes.push({ runId: id, value });
      this.column.set(id, value);
    };
    if (value === null && this.holdClear !== null) {
      return this.holdClear.then(write);
    }
    write();
    return Promise.resolve();
  }
  listRunsWithPendingWorkflowProposal(): Promise<
    { id: string; pendingWorkflowProposal: string | null }[]
  > {
    return Promise.resolve(
      [...this.column]
        .filter(([, value]) => value !== null)
        .map(([id, value]) => ({ id, pendingWorkflowProposal: value })),
    );
  }
}

/**
 * `ChatService`'s deferred-card half over a REAL registry, so a press goes
 * through the registry's own resolve — what decides that a second press finds
 * nothing. The rows it would write are recorded as calls.
 */
function fakeChats(approvals: ApprovalRegistry) {
  const track = (
    runId: string,
    requestId: string,
    card: DeferredCard,
    respond: DeferredCardResponder,
  ): void =>
    approvals.track({
      runId,
      nodeId: 'agent',
      requestId,
      toolName: card.toolName,
      input: card.input,
      question: false,
      deferred: true,
      respond: (allow, answer) => {
        respond(allow, answer);
        return true;
      },
    });
  return {
    raiseOwnedCard: vi.fn(
      (
        runId: string,
        requestId: string,
        card: DeferredCard,
        respond: DeferredCardResponder,
      ) => {
        track(runId, requestId, card, respond);
        return Promise.resolve();
      },
    ),
    trackOwnedCard: vi.fn(track),
    retireOwnedCard: vi.fn((runId: string, requestId: string) => {
      approvals.abandon(runId, requestId);
      return Promise.resolve();
    }),
    isArchived: vi.fn((_runId: string) => Promise.resolve(false)),
    deliverOwnedCardVerdict: vi.fn(
      (
        _runId: string,
        _requestId: string,
        _allow: boolean,
        _message: string,
        _answer?: string,
        _outcome?: WorkflowProposalOutcome,
      ) => Promise.resolve(),
    ),
  };
}

describe('WorkflowProposalService', () => {
  let dir: string;
  let store: WorkflowStoreService;
  let assertRunnable: ReturnType<typeof vi.fn>;
  let runs: FakeRuns;
  let approvals: ApprovalRegistry;
  let chats: ReturnType<typeof fakeChats>;
  /** The card ids the transcript already closes, per run. */
  let closedCards: Map<string, string[]>;
  let service: WorkflowProposalService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'geniro-proposal-'));
    store = new WorkflowStoreService({ workflowsDir: dir });
    assertRunnable = vi.fn((workflow: Workflow) =>
      Promise.resolve({ workflow, dropped: [] }),
    );
    runs = new FakeRuns();
    approvals = new ApprovalRegistry();
    chats = fakeChats(approvals);
    closedCards = new Map();
    service = new WorkflowProposalService(
      store,
      { assertRunnable } as unknown as GraphExecutorService,
      { fork: () => ({}) } as unknown as EntityManager,
      runs as unknown as RunDao,
      {
        rowsByPayloadId: (runId: string, _kinds: unknown, ids: string[]) =>
          Promise.resolve(
            (closedCards.get(runId) ?? [])
              .filter((id) => ids.includes(id))
              .map((id) => ({ id })),
          ),
      } as unknown as ItemDao,
      chats as unknown as ChatService,
    );
  });

  /** The verdict the agent was handed, once the press has been carried out. */
  async function verdictAfterPress(): Promise<{
    allow: boolean;
    message: string;
    answer: string | undefined;
    outcome: WorkflowProposalOutcome | undefined;
  }> {
    await vi.waitFor(() =>
      expect(chats.deliverOwnedCardVerdict).toHaveBeenCalled(),
    );
    const [, , allow, message, answer, outcome] =
      chats.deliverOwnedCardVerdict.mock.calls.at(-1)!;
    return { allow, message, answer, outcome };
  }

  function standingCard(runId: string): string {
    const entries = approvals.listByRun(runId);
    expect(entries).toHaveLength(1);
    return entries[0]!.requestId;
  }

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function proposed(
    request: Parameters<WorkflowProposalService['prepare']>[0],
  ): Promise<WorkflowProposal> {
    const prepared = await service.prepare(request);
    if (!prepared.ok) {
      throw new Error(`refused: ${prepared.code} ${prepared.message}`);
    }
    return prepared.proposal;
  }

  it('refuses a proposal whose agent node omits approval, rather than defaulting it to auto', async () => {
    const { approval: _omitted, ...bare } = TEAM.nodes[2] as Extract<
      Workflow['nodes'][number],
      { kind: 'agent' }
    >;
    const prepared = await service.prepare({
      workflow: { ...TEAM, nodes: [TEAM.nodes[0], TEAM.nodes[1], bare] },
    });

    expect(prepared).toMatchObject({ ok: false, code: 'INVALID_WORKFLOW' });
    expect(prepared.ok ? '' : prepared.message).toContain('approval');
    expect(assertRunnable).not.toHaveBeenCalled();
  });

  it('refuses what a run start would refuse, with the check’s own code', async () => {
    assertRunnable.mockRejectedValueOnce(
      new BadRequestException('GRAPH_NO_TRIGGER', 'add a trigger'),
    );

    await expect(service.prepare({ workflow: TEAM })).resolves.toEqual({
      ok: false,
      code: 'GRAPH_NO_TRIGGER',
      message: 'add a trigger',
    });
    expect(assertRunnable).toHaveBeenCalledWith(TEAM);
    await expect(readdir(dir)).resolves.toEqual([]);
  });

  it('creates under the slug fixed at proposal time, and reports exists if it was taken since', async () => {
    await store.create(TEAM);
    const first = await proposed({ workflow: TEAM, summary: '  two agents ' });
    expect(first).toMatchObject({
      mode: 'create',
      slug: 'review-team-2',
      summary: 'two agents',
    });
    await expect(service.apply(first)).resolves.toEqual({
      outcome: 'saved',
      slug: 'review-team-2',
      backup: null,
    });
    expect((await store.get('review-team-2')).workflow).toEqual(TEAM);

    const second = await proposed({ workflow: FASTER });
    expect(second.slug).toBe('review-team-3');
    await store.create(TEAM, 'review-team-3');
    await expect(service.apply(second)).resolves.toEqual({
      outcome: 'exists',
    });
    expect((await store.get('review-team-3')).workflow).toEqual(TEAM);
  });

  it('backs up then saves a replacement; reports changed without a backup when the file moved', async () => {
    await store.create(TEAM, 'team');
    const before = await readFile(store.locate('team').path, 'utf8');
    const replacement = await proposed({ workflow: FASTER, replaces: 'team' });
    expect(replacement).toMatchObject({
      mode: 'replace',
      slug: 'team',
      replacesName: 'Review Team',
      diff: { identical: false, changedNodes: [{ id: 'reviewer' }] },
    });

    const saved = await service.apply(replacement);
    expect(saved).toMatchObject({ outcome: 'saved', slug: 'team' });
    const backups = await readdir(join(dir, WORKFLOW_BACKUP_DIR));
    expect(saved).toEqual({
      outcome: 'saved',
      slug: 'team',
      backup: `${WORKFLOW_BACKUP_DIR}/${backups[0]}`,
    });
    await expect(
      readFile(join(dir, WORKFLOW_BACKUP_DIR, backups[0]!), 'utf8'),
    ).resolves.toBe(before);
    expect((await store.get('team')).workflow).toEqual(FASTER);

    const stale = await proposed({ workflow: TEAM, replaces: 'team' });
    await store.save('team', { ...FASTER, description: 'edited meanwhile' });
    await expect(service.apply(stale)).resolves.toEqual({
      outcome: 'changed',
    });
    await expect(readdir(join(dir, WORKFLOW_BACKUP_DIR))).resolves.toEqual(
      backups,
    );
    expect((await store.get('team')).workflow.description).toBe(
      'edited meanwhile',
    );
  });

  it('keeps a profile the agent saw only as a placeholder', async () => {
    const withProfile: Workflow = {
      ...TEAM,
      nodes: TEAM.nodes.map((node) =>
        node.id === 'coder'
          ? { ...node, configDir: '/Users/me/.claude-work' }
          : node,
      ),
    };
    await store.create(withProfile, 'team');
    const seen = redactConfigDirs(withProfile);
    const edited = {
      ...seen,
      nodes: seen.nodes.map((node) =>
        node.id === 'reviewer' ? { ...node, model: 'sonnet' } : node,
      ),
    };

    const replacement = await proposed({ workflow: edited, replaces: 'team' });
    await service.apply(replacement);

    const saved = (await store.get('team')).workflow.nodes.find(
      (node) => node.id === 'coder',
    );
    expect(saved).toMatchObject({ configDir: '/Users/me/.claude-work' });
    expect(replacement).toMatchObject({
      diff: { changedNodes: [{ id: 'reviewer' }] },
    });
  });

  it('never hands back a profile path it put back, nor a file line, in a refusal', async () => {
    const withProfile: Workflow = {
      ...TEAM,
      nodes: TEAM.nodes.map((node) =>
        node.id === 'coder'
          ? { ...node, configDir: '/Users/me/.claude-work' }
          : node,
      ),
    };
    await store.create(withProfile, 'team');
    assertRunnable.mockRejectedValueOnce(
      new BadRequestException(
        'INVALID_CONFIG_DIR',
        'Config directory does not exist: /Users/me/.claude-work',
      ),
    );
    const seen = redactConfigDirs(withProfile);

    await expect(
      service.prepare({ workflow: seen, replaces: 'team' }),
    ).resolves.toEqual({
      ok: false,
      code: 'INVALID_CONFIG_DIR',
      message: `Config directory does not exist: ${configDirToken('/Users/me/.claude-work')}`,
    });

    await writeFile(
      join(dir, 'team.geniro.yaml'),
      'name: team\nnodes:\n  - id: coder\n    configDir: /Users/me/.claude-work: x\n',
    );
    const broken = await service.prepare({ workflow: TEAM, replaces: 'team' });
    expect(broken).toMatchObject({ ok: false, code: 'WORKFLOW_YAML_INVALID' });
    expect(broken.ok ? '' : broken.message).not.toContain('/Users/me');
  });

  it('refuses a profile token it cannot place, rather than guessing or dropping it', async () => {
    await expect(
      service.prepare({
        workflow: {
          ...TEAM,
          nodes: TEAM.nodes.map((node) =>
            node.id === 'coder'
              ? { ...node, configDir: configDirToken('/Users/me/.claude-work') }
              : node,
          ),
        },
      }),
    ).resolves.toMatchObject({ ok: false, code: 'CONFIG_DIR_UNKNOWN' });
    expect(assertRunnable).not.toHaveBeenCalled();
  });

  it('reports gone for a replacement whose file was deleted, and does not re-create it', async () => {
    await store.create(TEAM, 'team');
    const replacement = await proposed({ workflow: FASTER, replaces: 'team' });
    await store.delete('team');

    await expect(service.apply(replacement)).resolves.toEqual({
      outcome: 'gone',
    });
    expect(await store.list()).toEqual([]);
  });

  it('refuses a replacement of a workflow not in the library, or identical to it', async () => {
    await expect(
      service.prepare({ workflow: TEAM, replaces: 'missing' }),
    ).resolves.toMatchObject({ ok: false, code: 'WORKFLOW_NOT_FOUND' });

    await store.create(TEAM, 'team');
    await expect(
      service.prepare({ workflow: TEAM, replaces: 'team' }),
    ).resolves.toMatchObject({ ok: false, code: 'NOTHING_TO_CHANGE' });
  });

  it('never writes while preparing', async () => {
    await writeFile(join(dir, 'keep.txt'), 'x');
    await proposed({ workflow: TEAM });
    await expect(readdir(dir)).resolves.toEqual(['keep.txt']);
  });

  describe("a builder chat's change", () => {
    const TO_SONNET = [{ path: 'nodes/reviewer/model', value: 'sonnet' }];

    it('applies the edits to the file as it stands and cards what, why and the difference', async () => {
      const { hash } = await store.create(TEAM, 'team');

      const prepared = await service.prepareChange({
        slug: 'team',
        edits: TO_SONNET,
        summary: ' Reviewer on sonnet ',
        reason: ' The user asked\nfor a cheaper reviewer. ',
      });

      expect(prepared).toEqual({
        ok: true,
        proposal: {
          mode: 'replace',
          autoAgents: ['reviewer'],
          summary: 'Reviewer on sonnet',
          reason: 'The user asked\nfor a cheaper reviewer.',
          slug: 'team',
          replacesName: 'Review Team',
          diff: expect.objectContaining({
            identical: false,
            changedNodes: [expect.objectContaining({ id: 'reviewer' })],
          }),
          baseHash: hash,
          workflow: FASTER,
        },
      });
      expect((await store.get('team')).workflow).toEqual(TEAM);
    });

    it('holds a change to the graph rules, not to whether it could run yet', async () => {
      // A workflow is built up over several changes: an agent nobody feeds
      // yet would fail a run start, and is still a change worth carding.
      await store.create(TEAM, 'team');

      const prepared = await service.prepareChange({
        slug: 'team',
        edits: [
          {
            path: 'nodes/-',
            value: {
              id: 'tester',
              kind: 'agent',
              agent: 'codex',
              approval: 'ask',
            },
          },
        ],
      });

      expect(prepared.ok).toBe(true);
      expect(assertRunnable).not.toHaveBeenCalled();
    });

    it('refuses edits that do not apply, break the graph, or change nothing', async () => {
      await store.create(TEAM, 'team');
      const refusal = async (edits: WorkflowEdit[]) => {
        const prepared = await service.prepareChange({ slug: 'team', edits });
        return prepared.ok ? null : prepared.code;
      };

      expect(await refusal([{ find: 'no such text', replace: 'x' }])).toBe(
        'INVALID_EDIT',
      );
      expect(
        await refusal([
          {
            path: 'edges/-',
            value: { from: 'coder', to: 'ghost', kind: 'data' },
          },
        ]),
      ).toBe('INVALID_WORKFLOW');
      expect(
        await refusal([{ path: 'nodes/reviewer/approval', value: 'auto' }]),
      ).toBe('NOTHING_TO_CHANGE');
    });

    it('refuses a deleted file, and an unreadable one by its first line only', async () => {
      await expect(
        service.prepareChange({ slug: 'team', edits: TO_SONNET }),
      ).resolves.toMatchObject({ ok: false, code: 'WORKFLOW_GONE' });

      await writeFile(
        store.locate('team').path,
        'name: Team\nnodes: [\n  configDir: /Users/me/.claude-work\n',
      );
      const unreadable = await service.prepareChange({
        slug: 'team',
        edits: TO_SONNET,
      });
      expect(unreadable).toMatchObject({
        ok: false,
        code: 'WORKFLOW_UNREADABLE',
      });
      expect(unreadable.ok ? '' : unreadable.message).not.toContain(
        '.claude-work',
      );
    });

    it('puts a profile written back as its token back as its path', async () => {
      const withProfile: Workflow = {
        ...TEAM,
        nodes: TEAM.nodes.map((node) =>
          node.id === 'coder'
            ? { ...node, configDir: '/Users/me/.claude-work' }
            : node,
        ),
      };
      await store.create(withProfile, 'team');
      const token = configDirToken('/Users/me/.claude-work');

      const kept = await service.prepareChange({
        slug: 'team',
        edits: [
          { path: 'nodes/reviewer/configDir', value: token },
          ...TO_SONNET,
        ],
      });
      const guessed = await service.prepareChange({
        slug: 'team',
        edits: [
          {
            path: 'nodes/reviewer/configDir',
            value: configDirToken('/Users/me/.other'),
          },
        ],
      });

      expect(kept.ok ? kept.proposal.workflow.nodes[2] : null).toMatchObject({
        id: 'reviewer',
        configDir: '/Users/me/.claude-work',
      });
      expect(guessed).toMatchObject({ ok: false, code: 'CONFIG_DIR_UNKNOWN' });
    });

    it('saves exactly the carded change on Approve, backing the file up first', async () => {
      await store.create(TEAM, 'team');
      const before = await readFile(store.locate('team').path, 'utf8');

      await expect(
        service.proposeChange('run-1', {
          slug: 'team',
          edits: TO_SONNET,
          summary: 'Reviewer on sonnet',
          reason: 'The user asked for it.',
        }),
      ).resolves.toMatchObject({ status: 'shown' });
      expect(approvals.listByRun('run-1')[0]).toMatchObject({
        toolName: 'propose_workflow',
        input: { mode: 'replace', reason: 'The user asked for it.' },
      });
      expect((await store.get('team')).workflow).toEqual(TEAM);

      approvals.resolve('run-1', standingCard('run-1'), true);

      const { message } = await verdictAfterPress();
      expect(message).toContain("Approved — saved as 'team'");
      expect((await store.get('team')).workflow).toEqual(FASTER);
      const backups = await readdir(join(dir, WORKFLOW_BACKUP_DIR));
      await expect(
        readFile(join(dir, WORKFLOW_BACKUP_DIR, backups[0]!), 'utf8'),
      ).resolves.toBe(before);
    });

    it('saves nothing on Approve when the canvas changed the file after the card went up', async () => {
      await store.create(TEAM, 'team');
      await service.proposeChange('run-1', { slug: 'team', edits: TO_SONNET });
      await store.save('team', {
        ...TEAM,
        description: 'edited on the canvas',
      });

      approvals.resolve('run-1', standingCard('run-1'), true);

      const { outcome } = await verdictAfterPress();
      expect(outcome).toEqual({ kind: 'not-saved', cause: 'changed' });
      expect((await store.get('team')).workflow).toEqual({
        ...TEAM,
        description: 'edited on the canvas',
      });
    });
  });

  describe('the card', () => {
    it('names every agent that runs tools without asking, pool members included', async () => {
      const pooled: Workflow = {
        ...TEAM,
        nodes: TEAM.nodes.map((node) =>
          node.id === 'coder'
            ? {
                ...node,
                name: 'Coder',
                pool: [
                  { agent: 'codex' },
                  { agent: 'claude', approval: 'auto' },
                ],
              }
            : node,
        ),
      } as Workflow;

      await expect(proposed({ workflow: pooled })).resolves.toMatchObject({
        autoAgents: ['Coder (coder) — pool member 3', 'reviewer'],
      });
    });

    it('tells the agent why a model cannot run, so it can choose another', async () => {
      assertRunnable.mockRejectedValueOnce(
        new Error(
          'Cannot use Ollama model qwen: This model does not support tool calling.',
        ),
      );

      await expect(service.prepare({ workflow: TEAM })).resolves.toEqual({
        ok: false,
        code: 'MODEL_UNAVAILABLE',
        message:
          'Cannot use Ollama model qwen: This model does not support tool calling.',
      });
    });

    it("refuses a graph-rule break with the rule's own code", async () => {
      const prepared = await service.prepare({
        workflow: {
          ...TEAM,
          edges: [
            ...TEAM.edges,
            { from: 'reviewer', to: 'ghost', kind: 'data' },
          ],
        },
      });

      expect(prepared.ok).toBe(false);
      expect(prepared.ok ? '' : prepared.code).toMatch(/^GRAPH_/);
      expect(assertRunnable).not.toHaveBeenCalled();
    });

    it('refuses a check that failed with no error at all', async () => {
      assertRunnable.mockRejectedValueOnce('boom');

      await expect(service.prepare({ workflow: TEAM })).resolves.toEqual({
        ok: false,
        code: 'NOT_RUNNABLE',
        message: 'the check could not be completed',
      });
    });

    it('still answers the agent when undoing a half-raised card fails too', async () => {
      runs.failWrite = (value) => value !== null;
      chats.retireOwnedCard.mockRejectedValueOnce(new Error('SQLITE_FULL'));

      await expect(
        service.propose('run-1', { workflow: TEAM }),
      ).resolves.toMatchObject({ status: 'refused', code: 'CARD_NOT_SHOWN' });
    });

    it('reports an unreadable file as not written, never as deleted', async () => {
      await store.create(TEAM, 'team');
      await service.propose('run-1', { workflow: FASTER, replaces: 'team' });
      await chmod(store.locate('team').path, 0o000);

      approvals.resolve('run-1', standingCard('run-1'), true);

      const { message } = await verdictAfterPress();
      await chmod(store.locate('team').path, 0o644);
      expect(message).toContain('Not saved — the file could not be written');
    });

    it('refuses an unreadable library file without passing its error to the agent', async () => {
      vi.spyOn(store, 'get').mockRejectedValueOnce(
        new Error("EACCES: open '/Users/me/geniro/team.geniro.yaml'"),
      );

      await expect(
        service.prepare({ workflow: TEAM, replaces: 'team' }),
      ).resolves.toEqual({
        ok: false,
        code: 'WORKFLOW_NOT_FOUND',
        message: 'the check could not be completed',
      });
    });

    it('does not write off a card the user pressed while a newer proposal was being raised', async () => {
      await service.propose('run-1', { workflow: TEAM });
      const first = standingCard('run-1');
      let release!: () => void;
      runs.holdClear = new Promise((resolve) => {
        release = resolve;
      });

      approvals.resolve('run-1', first, true);
      await service.propose('run-1', { workflow: FASTER });
      release();
      await verdictAfterPress();

      expect(chats.retireOwnedCard).not.toHaveBeenCalledWith(
        'run-1',
        first,
        'propose_workflow',
      );
    });

    it('tracks the old card again when retiring it fails before its row is written', async () => {
      await service.propose('run-1', { workflow: TEAM });
      const first = standingCard('run-1');
      chats.retireOwnedCard.mockImplementationOnce(
        (runId: string, requestId: string) => {
          approvals.abandon(runId, requestId);
          return Promise.reject(new Error('SQLITE_FULL'));
        },
      );

      await expect(
        service.propose('run-1', { workflow: FASTER }),
      ).resolves.toMatchObject({ status: 'refused', code: 'CARD_NOT_SHOWN' });
      expect(standingCard('run-1')).toBe(first);
      expect(JSON.parse(runs.column.get('run-1')!).requestId).toBe(first);
    });

    it('drops, rather than re-arms, a card the transcript already closed', async () => {
      await service.propose('run-1', { workflow: TEAM });
      const first = standingCard('run-1');
      approvals.sweepDeferred('run-1');
      closedCards.set('run-1', [first]);

      await service.rehydrate();

      expect(approvals.listByRun('run-1')).toEqual([]);
      expect(runs.column.get('run-1')).toBeNull();
    });

    it('rehydrates the other runs when one of them fails', async () => {
      await service.propose('run-1', { workflow: TEAM });
      await service.propose('run-2', { workflow: TEAM });
      const second = standingCard('run-2');
      approvals.sweepDeferred('run-1');
      approvals.sweepDeferred('run-2');
      chats.trackOwnedCard.mockImplementationOnce(() => {
        throw new Error('boom');
      });

      await service.rehydrate();

      expect(standingCard('run-2')).toBe(second);
    });

    it('raises a valid proposal on a card that stands durably, and an invalid one on none', async () => {
      await expect(
        service.propose('run-1', { workflow: { name: 'x' } }),
      ).resolves.toMatchObject({ status: 'refused', code: 'INVALID_WORKFLOW' });
      expect(chats.raiseOwnedCard).not.toHaveBeenCalled();

      const shown = await service.propose('run-1', { workflow: TEAM });

      expect(shown).toMatchObject({
        status: 'shown',
        proposal: { mode: 'create', slug: 'review-team' },
      });
      const requestId = standingCard('run-1');
      expect(chats.raiseOwnedCard).toHaveBeenCalledWith(
        'run-1',
        requestId,
        {
          toolName: 'propose_workflow',
          input: shown.status === 'shown' ? shown.proposal : null,
        },
        expect.any(Function),
      );
      expect(JSON.parse(runs.column.get('run-1')!)).toMatchObject({
        requestId,
        proposal: { slug: 'review-team' },
      });
      await expect(readdir(dir)).resolves.toEqual([]);
    });

    it('retires the standing card when a newer proposal arrives', async () => {
      await service.propose('run-1', { workflow: TEAM });
      const first = standingCard('run-1');

      await service.propose('run-1', { workflow: FASTER });

      expect(chats.retireOwnedCard).toHaveBeenCalledWith(
        'run-1',
        first,
        'propose_workflow',
      );
      const second = standingCard('run-1');
      expect(second).not.toBe(first);
      expect(JSON.parse(runs.column.get('run-1')!).requestId).toBe(second);
    });

    it('keeps one card standing when two proposals arrive in the same tick', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      assertRunnable.mockImplementation((workflow: Workflow) =>
        gate.then(() => ({ workflow, dropped: [] })),
      );
      const both = Promise.all([
        service.propose('run-1', { workflow: TEAM }),
        service.propose('run-1', { workflow: FASTER }),
      ]);
      await vi.waitFor(() => expect(assertRunnable).toHaveBeenCalledTimes(1));
      await new Promise((resolve) => setImmediate(resolve));
      // The second waits for the first to stand, rather than both reading the
      // run before either has written its card.
      expect(assertRunnable).toHaveBeenCalledTimes(1);
      release();
      await both;

      const standing = standingCard('run-1');
      expect(JSON.parse(runs.column.get('run-1')!).requestId).toBe(standing);
      expect(chats.retireOwnedCard).toHaveBeenCalledTimes(1);
    });

    it('clears the card before writing, saves once however often it is pressed, and tells the agent', async () => {
      await service.propose('run-1', { workflow: TEAM });
      const requestId = standingCard('run-1');
      const path = store.locate('review-team').path;
      let fileAtClear: string | null = 'unread';
      runs.onWrite = (value) => {
        if (value === null) {
          fileAtClear = readFileSyncOrNull(path);
        }
      };

      expect(approvals.resolve('run-1', requestId, true)).toBe(true);
      expect(approvals.resolve('run-1', requestId, true)).toBe(false);

      await expect(verdictAfterPress()).resolves.toEqual({
        allow: true,
        message: "(Approved — saved as 'review-team' in the workflow library.)",
        answer: undefined,
        outcome: { kind: 'saved', slug: 'review-team' },
      });
      expect(fileAtClear).toBeNull();
      expect(runs.column.get('run-1')).toBeNull();
      expect((await store.get('review-team')).workflow).toEqual(TEAM);
      expect((await store.list()).map((w) => w.slug)).toEqual(['review-team']);
      expect(chats.deliverOwnedCardVerdict).toHaveBeenCalledTimes(1);
    });

    it('carries the decline note to the verdict and the next message, and writes nothing', async () => {
      await service.propose('run-1', { workflow: TEAM });
      const requestId = standingCard('run-1');

      approvals.resolve('run-1', requestId, false, 'only one reviewer');

      await expect(verdictAfterPress()).resolves.toEqual({
        allow: false,
        message:
          "(Declined — nothing was saved. The user's note: only one reviewer)",
        answer: 'only one reviewer',
        outcome: undefined,
      });
      expect(runs.column.get('run-1')).toBeNull();
      await expect(readdir(dir)).resolves.toEqual([]);
    });

    it('tells the agent nothing was saved when the file changed after the proposal', async () => {
      await store.create(TEAM, 'team');
      await service.propose('run-1', { workflow: FASTER, replaces: 'team' });
      await store.save('team', { ...TEAM, description: 'edited meanwhile' });

      approvals.resolve('run-1', standingCard('run-1'), true);

      const { message, outcome } = await verdictAfterPress();
      expect(message).toContain(
        "Not saved — the workflow 'team' changed after you proposed replacing it",
      );
      expect(outcome).toEqual({ kind: 'not-saved', cause: 'changed' });
      expect((await store.get('team')).workflow.description).toBe(
        'edited meanwhile',
      );
    });

    it('records on the verdict why an approval wrote nothing: the slug was taken, or the file deleted', async () => {
      await service.propose('run-1', { workflow: TEAM });
      await store.create(FASTER, 'review-team');
      approvals.resolve('run-1', standingCard('run-1'), true);
      expect((await verdictAfterPress()).outcome).toEqual({
        kind: 'not-saved',
        cause: 'exists',
      });

      await store.create(TEAM, 'team');
      await service.propose('run-2', { workflow: FASTER, replaces: 'team' });
      await store.delete('team');
      approvals.resolve('run-2', standingCard('run-2'), true);
      await vi.waitFor(() =>
        expect(chats.deliverOwnedCardVerdict).toHaveBeenCalledTimes(2),
      );
      expect((await verdictAfterPress()).outcome).toEqual({
        kind: 'not-saved',
        cause: 'gone',
      });
    });

    it('passes the note typed on Approve to the agent', async () => {
      await service.propose('run-1', { workflow: TEAM });
      approvals.resolve('run-1', standingCard('run-1'), true, 'rename it');

      await expect(verdictAfterPress()).resolves.toMatchObject({
        allow: true,
        message:
          "(Approved — saved as 'review-team' in the workflow library. The user's note: rename it)",
        answer: 'rename it',
      });
    });

    it('writes nothing on Approve when the card could not be closed', async () => {
      await service.propose('run-1', { workflow: TEAM });
      runs.failWrite = (value) => value === null;

      approvals.resolve('run-1', standingCard('run-1'), true);

      const { message, outcome } = await verdictAfterPress();
      expect(message).toBe(
        '(Not saved — the card could not be closed, so nothing was written. Read the library again with read_workflows before proposing again.)',
      );
      expect(outcome).toEqual({ kind: 'not-saved', cause: 'not-closed' });
      await expect(readdir(dir)).resolves.toEqual([]);
    });

    it('tells the agent the file could not be written when the save throws', async () => {
      await service.propose('run-1', { workflow: TEAM });
      vi.spyOn(store, 'create').mockRejectedValueOnce(
        new Error('EACCES: /Users/someone/Library/geniro/workflows'),
      );

      approvals.resolve('run-1', standingCard('run-1'), true);

      const { message, outcome } = await verdictAfterPress();
      expect(message).toContain('Not saved — the file could not be written');
      expect(message).not.toContain('/Users/');
      expect(outcome).toEqual({ kind: 'not-saved', cause: 'write-failed' });
    });

    it('refuses without a path, and leaves the standing card, when the card cannot be written', async () => {
      await service.propose('run-1', { workflow: TEAM });
      const first = standingCard('run-1');
      chats.raiseOwnedCard.mockRejectedValueOnce(
        new Error('SQLITE_FULL: /private/geniro.db'),
      );

      await expect(
        service.propose('run-1', { workflow: FASTER }),
      ).resolves.toEqual({
        status: 'refused',
        code: 'CARD_NOT_SHOWN',
        message: 'the proposal card could not be written',
      });
      // The old card was retired before the raise failed, so its pointer goes
      // with it rather than coming back at boot as a live card.
      expect(chats.retireOwnedCard).toHaveBeenCalledWith(
        'run-1',
        first,
        'propose_workflow',
      );
      expect(runs.column.get('run-1')).toBeNull();
    });

    it('takes a raised card down again when its column cannot be written', async () => {
      runs.failWrite = (value) => value !== null;

      await expect(
        service.propose('run-1', { workflow: TEAM }),
      ).resolves.toMatchObject({ status: 'refused', code: 'CARD_NOT_SHOWN' });
      expect(approvals.listByRun('run-1')).toEqual([]);
      expect(chats.retireOwnedCard).toHaveBeenCalledTimes(1);
    });

    it('takes the card down when the chat was archived while it was raised', async () => {
      chats.isArchived.mockResolvedValueOnce(true);

      await expect(
        service.propose('run-1', { workflow: TEAM }),
      ).resolves.toMatchObject({ status: 'refused', code: 'CARD_NOT_SHOWN' });
      expect(approvals.listByRun('run-1')).toEqual([]);
      expect(runs.column.get('run-1')).toBeNull();
      expect(chats.retireOwnedCard).toHaveBeenCalledTimes(1);
    });

    it('keeps booting when the standing proposals cannot be read', async () => {
      vi.spyOn(
        runs,
        'listRunsWithPendingWorkflowProposal',
      ).mockRejectedValueOnce(new Error('no such table'));
      await expect(service.rehydrate()).resolves.toBeUndefined();
    });

    it('rehydrates a standing proposal after a restart and clears an unparseable column', async () => {
      await service.propose('run-1', { workflow: TEAM });
      const requestId = standingCard('run-1');
      approvals.sweepDeferred('run-1');
      runs.column.set('run-2', '{"requestId":"x"}');
      runs.column.set('run-3', 'not json');

      await service.rehydrate();

      expect(standingCard('run-1')).toBe(requestId);
      expect(approvals.listByRun('run-2')).toEqual([]);
      expect(runs.column.get('run-2')).toBeNull();
      expect(runs.column.get('run-3')).toBeNull();
      // A card whose proposal no longer reads is closed, not left live.
      expect(chats.retireOwnedCard.mock.calls).toEqual([
        ['run-2', 'x', 'propose_workflow'],
      ]);
      approvals.resolve('run-1', requestId, true);
      expect((await verdictAfterPress()).allow).toBe(true);
      expect((await store.get('review-team')).workflow).toEqual(TEAM);
    });
  });
});

function readFileSyncOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}
