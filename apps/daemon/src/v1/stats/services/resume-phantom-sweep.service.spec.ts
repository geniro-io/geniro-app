import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  defineConfig,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ClaudeAdapter } from '../../agents/adapters/claude/claude.adapter';
import { SINGLE_AGENT_NODE } from '../../agents/chat.types';
import { ItemDao } from '../../agents/dao/item.dao';
import { NodeStateDao } from '../../agents/dao/node-state.dao';
import { RunDao } from '../../agents/dao/run.dao';
import { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import { workflowSnapshotOf } from '../../graphs/utils/workflow-snapshot';
import { Item } from '../../runs/entity/item.entity';
import { NodeState } from '../../runs/entity/node-state.entity';
import { Run } from '../../runs/entity/run.entity';
import type { ItemKind } from '../../runs/runs.types';
import { UsageEventDao } from '../dao/usage-event.dao';
import { UsageEvent } from '../entity/usage-event.entity';
import { ResumePhantomSweepService } from './resume-phantom-sweep.service';

/** Real DAOs on an in-memory database, and a real claude adapter reading transcripts. */
describe('ResumePhantomSweepService (in-memory sqlite)', () => {
  const SESSION = '3971edc7-bdd6-4f42-96dd-262acd4e18c3';
  const EARLIER = 17.4528626;
  const LATER = 30.753244199999997;

  let orm: MikroORM;
  let itemDao: ItemDao;
  let runDao: RunDao;
  let nodeStateDao: NodeStateDao;
  let usageDao: UsageEventDao;
  let markerDir: string;

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        dbName: ':memory:',
        entities: [Run, Item, NodeState, UsageEvent],
        ignoreUndefinedInQuery: true,
        allowGlobalContext: true,
        namingStrategy: UnderscoreNamingStrategy,
        discovery: { checkDuplicateFieldNames: false },
      }),
    );
    await orm.schema.create();
  });

  afterAll(async () => {
    await orm.close(true);
  });

  beforeEach(async () => {
    await orm.schema.clear();
    const em = orm.em.fork();
    itemDao = new ItemDao(em);
    runDao = new RunDao(em);
    nodeStateDao = new NodeStateDao(em);
    usageDao = new UsageEventDao(em);
    markerDir = mkdtempSync(join(tmpdir(), 'resume-phantom-marker-'));
  });

  function sweeper(
    adapter: ClaudeAdapter = new ClaudeAdapter({
      // A run naming no profile reads the default one: never the real home.
      homeDir: mkdtempSync(join(tmpdir(), 'resume-phantom-home-')),
    }),
  ): ResumePhantomSweepService {
    return new ResumePhantomSweepService(
      orm.em.fork(),
      itemDao,
      runDao,
      nodeStateDao,
      usageDao,
      new AgentAdapterRegistry([adapter]),
      join(markerDir, 'marker'),
    );
  }

  /** A profile holding SESSION's transcript with these cost-state totals. */
  function profileWith(totals: number[]): string {
    const profile = mkdtempSync(join(tmpdir(), 'resume-phantom-'));
    mkdirSync(join(profile, 'projects', '-work'), { recursive: true });
    writeFileSync(
      join(profile, 'projects', '-work', `${SESSION}.jsonl`),
      totals
        .map((totalCostUSD) =>
          JSON.stringify({
            type: 'cost-state',
            sessionId: SESSION,
            totalCostUSD,
          }),
        )
        .join('\n'),
    );
    return profile;
  }

  /** The node's other call conversation, holding no transcript here. */
  const OTHER_SESSION = 'a1c17e83-1355-4546-b015-50e3d2b04f4c';

  async function workflowRun(
    profile: string,
    sessions: string[] = [SESSION],
  ): Promise<void> {
    await runDao.create({
      id: 'run-wf',
      workflowId: 'dev-team',
      workflowSnapshot: workflowSnapshotOf({
        name: 'Dev team',
        nodes: [
          {
            id: 'middle',
            kind: 'agent',
            agent: 'claude',
            approval: 'auto',
            configDir: profile,
          },
        ],
        edges: [],
      }),
    });
    await nodeStateDao.create({
      runId: 'run-wf',
      nodeId: 'middle',
      agentKind: 'claude',
      agentSessionId: sessions[sessions.length - 1],
      sessionIds: JSON.stringify(sessions),
    });
  }

  /** One recorded turn and its transcript row, as the live recorder writes them. */
  async function recorded(
    seq: number,
    figures: { costUsd: number; durationMs: number; numTurns: number },
    {
      runId = 'run-wf',
      nodeId = 'middle' as string | null,
      kind = 'turn_complete' as ItemKind,
    } = {},
  ): Promise<void> {
    await itemDao.create({
      runId,
      nodeId,
      seq,
      kind,
      payload: JSON.stringify({
        usage: { ...figures, inputTokens: 0, outputTokens: 0 },
      }),
    });
    await usageDao.recordOnce({
      runId,
      nodeId,
      seq,
      occurredAt: new Date(),
      agentKind: 'claude',
      model: 'claude-haiku-5-5',
      cwd: '/work',
      workflowName: null,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      thinkingTokens: 0,
      apiMs: 0,
      ttftMs: null,
      timeToRequestMs: null,
      ...figures,
    });
  }

  /** A turn that did work, billed before the row under test. */
  const worked = (costUsd: number) => ({
    costUsd,
    durationMs: 60_000,
    numTurns: 4,
  });
  const quiet = (costUsd: number) => ({ costUsd, durationMs: 49, numTurns: 0 });

  async function itemCost(seq: number, runId = 'run-wf'): Promise<unknown> {
    const item = await itemDao.getOne(
      { runId, seq },
      { disableIdentityMap: true },
    );
    return (
      JSON.parse(item?.payload ?? '{}') as { usage?: { costUsd?: unknown } }
    ).usage?.costUsd;
  }

  const seqs = async (): Promise<number[]> =>
    (await usageDao.getAll({})).map((row) => row.seq).sort((a, b) => a - b);

  const rowCost = async (seq: number): Promise<number | null | undefined> =>
    (await usageDao.getOne({ seq }, { disableIdentityMap: true }))?.costUsd;

  const NONE = { removed: 0, restated: 0 };
  const REMOVED = { removed: 1, restated: 0 };

  it('removes a turn that re-billed a total its node had already billed, and zeroes its transcript row', async () => {
    await workflowRun(profileWith([EARLIER, LATER]));
    await recorded(9, worked(LATER));
    await recorded(10, quiet(LATER));

    expect(await sweeper().sweep()).toEqual(REMOVED);

    expect(await seqs()).toEqual([9]);
    expect(await itemCost(10)).toBe(0);
  });

  it('restates a total to the share its node had not billed yet', async () => {
    // $21.54 billed by the replaced process's results; the rest of its
    // $30.75 it spent after its last one, and only this row holds it.
    // The node's other call conversation billed $10 before that, and is not
    // this session's to subtract.
    await workflowRun(profileWith([EARLIER, LATER]));
    await recorded(5, worked(10));
    await recorded(9, worked(21.54));
    await recorded(10, quiet(LATER));

    expect(await sweeper().sweep()).toEqual({ removed: 0, restated: 1 });

    expect(await rowCost(10)).toBeCloseTo(LATER - 21.54, 9);
    expect(await itemCost(10)).toBeCloseTo(LATER - 21.54, 9);
  });

  it('leaves a total nothing was billed before — it may be the only bill that spend got', async () => {
    await workflowRun(profileWith([EARLIER, LATER]));
    await recorded(10, quiet(LATER));

    expect(await sweeper().sweep()).toEqual(NONE);
    expect(await rowCost(10)).toBe(LATER);
  });

  it('leaves a total whose node billed only an earlier conversation before it', async () => {
    // The node's other call conversation spent $40; this one's first process
    // was billed nothing before its total — the row is that spend's only bill.
    await workflowRun(profileWith([LATER]));
    await recorded(1, worked(40));
    await recorded(2, quiet(LATER));

    expect(await sweeper().sweep()).toEqual(NONE);
    expect(await rowCost(2)).toBe(LATER);
  });

  it('on a node with several conversations, removes only an exact repeat and leaves a share alone', async () => {
    // Which of its turns were this session's, the ledger cannot say.
    await workflowRun(profileWith([EARLIER, LATER]), [SESSION, OTHER_SESSION]);
    await recorded(1, worked(LATER));
    await recorded(2, quiet(LATER));
    await recorded(3, worked(21.54));
    await recorded(4, quiet(LATER));

    expect(await sweeper().sweep()).toEqual(REMOVED);
    expect(await seqs()).toEqual([1, 3, 4]);
    expect(await rowCost(4)).toBe(LATER);
  });

  it('removes a gap only when the node’s turns just before it already billed it', async () => {
    await workflowRun(profileWith([EARLIER, LATER]));
    // The replaced process's own results: they add up to the gap exactly.
    await recorded(1, worked(9));
    await recorded(2, worked(LATER - EARLIER - 9));
    await recorded(3, quiet(LATER - EARLIER));

    expect(await sweeper().sweep()).toEqual(REMOVED);
    expect(await seqs()).toEqual([1, 2]);
  });

  it('keeps a gap nothing billed — a process killed mid-turn, its spend landing on the next line', async () => {
    await workflowRun(profileWith([EARLIER, LATER]));
    await recorded(1, worked(EARLIER));
    await recorded(2, quiet(LATER - EARLIER));

    expect(await sweeper().sweep()).toEqual(NONE);
    expect(await itemCost(2)).toBe(LATER - EARLIER);
  });

  it('proves a gap only from its own node’s turns', async () => {
    await workflowRun(profileWith([EARLIER, LATER]));
    await nodeStateDao.create({ runId: 'run-wf', nodeId: 'qa' });
    await recorded(1, worked(LATER - EARLIER), { nodeId: 'qa' });
    await recorded(2, quiet(LATER - EARLIER));

    expect(await sweeper().sweep()).toEqual(NONE);
    expect(await seqs()).toEqual([1, 2]);
  });

  it('removes a chat’s phantom, whose session the node holds only as the one to resume', async () => {
    const profile = profileWith([LATER]);
    await runDao.create({
      id: 'run-chat',
      agentKind: 'claude',
      configDir: profile,
    });
    await nodeStateDao.create({
      runId: 'run-chat',
      nodeId: SINGLE_AGENT_NODE,
      agentSessionId: SESSION,
    });
    const chat = { runId: 'run-chat', nodeId: null };
    await recorded(6, worked(LATER), chat);
    await recorded(7, quiet(LATER), chat);

    expect(await sweeper().sweep()).toEqual(REMOVED);
    expect(await itemCost(7, 'run-chat')).toBe(0);
  });

  it('zeroes the transcript row of a phantom recorded off a failed turn', async () => {
    await workflowRun(profileWith([LATER]));
    await recorded(9, worked(LATER));
    await recorded(10, quiet(LATER), { kind: 'error' });

    expect(await sweeper().sweep()).toEqual(REMOVED);
    expect(await itemCost(10)).toBe(0);
  });

  it('leaves what it cannot prove: no matching total, a long turn, or no transcript', async () => {
    await workflowRun(profileWith([EARLIER, LATER]));
    await recorded(9, worked(LATER));
    await recorded(10, quiet(2.1405));
    await recorded(11, { costUsd: LATER, durationMs: 50_451, numTurns: 0 });
    await runDao.create({ id: 'run-gone', agentKind: 'claude' });
    await nodeStateDao.create({
      runId: 'run-gone',
      nodeId: SINGLE_AGENT_NODE,
      agentSessionId: '0d9e1f2a-3b4c-4d5e-8f60-718293a4b5c6',
    });
    const gone = { runId: 'run-gone', nodeId: null };
    await recorded(12, worked(LATER), gone);
    await recorded(13, quiet(LATER), gone);

    expect(await sweeper().sweep()).toEqual(NONE);

    expect(await seqs()).toEqual([9, 10, 11, 12, 13]);
    expect(await itemCost(10)).toBe(2.1405);
  });

  it('runs once per profile: a finished pass retires it', async () => {
    await workflowRun(profileWith([EARLIER, LATER]));
    await recorded(9, worked(LATER));
    await recorded(10, quiet(LATER));
    expect(await sweeper().sweep()).toEqual(REMOVED);

    await recorded(11, quiet(LATER));

    expect(await sweeper().sweep()).toEqual(NONE);
    expect(await seqs()).toEqual([9, 11]);
  });

  it('keeps the sweep armed after a pass that could not read a transcript', async () => {
    const profile = profileWith([LATER]);
    const transcript = join(profile, 'projects', '-work', `${SESSION}.jsonl`);
    await workflowRun(profile);
    await recorded(9, worked(LATER));
    await recorded(10, quiet(LATER));
    // A permission bit does not restrict uid 0, so under root the transcript
    // stays readable and this case cannot be built.
    expect(process.getuid?.()).not.toBe(0);
    chmodSync(transcript, 0o000);
    try {
      expect(await sweeper().sweep()).toEqual(NONE);
      expect(await seqs()).toEqual([9, 10]);
    } finally {
      chmodSync(transcript, 0o644);
    }

    expect(await sweeper().sweep()).toEqual(REMOVED);
  });

  it.each([
    ['another version', '0\n'],
    ['nothing readable', 'not a version'],
  ])('runs again over a marker holding %s', async (_, marker) => {
    await workflowRun(profileWith([LATER]));
    await recorded(9, worked(LATER));
    await recorded(10, quiet(LATER));
    writeFileSync(join(markerDir, 'marker'), marker);

    expect(await sweeper().sweep()).toEqual(REMOVED);
  });
});
