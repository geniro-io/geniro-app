import {
  defineConfig,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { freshVocabularyStore } from '../../agents/adapters/__tests__/fresh-vocabulary-store';
import { ClaudeAdapter } from '../../agents/adapters/claude/claude.adapter';
import { CodexAdapter } from '../../agents/adapters/codex/codex.adapter';
import { CursorAcpAdapter } from '../../agents/adapters/cursor-acp/cursor-acp.adapter';
import { RunDao } from '../../agents/dao/run.dao';
import { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import { workflowSnapshotOf } from '../../graphs/utils/workflow-snapshot';
import { Run } from '../../runs/entity/run.entity';
import { AgentKind } from '../../runs/runs.types';
import { UsageEventDao } from '../dao/usage-event.dao';
import { UsageEvent } from '../entity/usage-event.entity';
import type { UsageEventInput } from '../stats.types';
import { polledSpendRows } from '../utils/polled-spend';
import { ProjectRootsService } from './project-roots.service';
import { StatsService } from './stats.service';

/**
 * Real database, real DAO: the range predicate is half-open and the day buckets
 * are local-time, and both are properties of the SQL and the fold working
 * together. A faked DAO would let the service's arrangement pass while the
 * query it depends on returned a different set of rows.
 */
describe('StatsService (in-memory sqlite)', () => {
  let orm: MikroORM;
  let service: StatsService;
  let dao: UsageEventDao;

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        dbName: ':memory:',
        // `Run` rides along so a spec can put a priced run row BESIDE the
        // ledger and prove the service reads only the ledger's copy of it.
        entities: [UsageEvent, Run],
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
    dao = new UsageEventDao(em);
    service = new StatsService(
      em,
      dao,
      // Which CLIs' money is polled is each adapter's own declaration
      // (`usage.polledSpend`), so the registry is the real one.
      new AgentAdapterRegistry([
        new ClaudeAdapter(),
        new CursorAcpAdapter({ vocabularyStore: freshVocabularyStore() }),
        new CodexAdapter(),
      ]),
      new ProjectRootsService(em),
      new RunDao(em),
    );
  });

  /**
   * The route hands the service ISO strings; these tests are written in local
   * `Date`s because the bucketing they check is local-time. Converting here
   * keeps every case readable without weakening what it drives.
   */
  function readUsage(
    from?: Date,
    to?: Date,
  ): ReturnType<StatsService['usage']> {
    return service.usage(from?.toISOString(), to?.toISOString());
  }

  let nextSeq = 0;
  async function record(
    occurredAt: Date,
    overrides: Partial<UsageEventInput> = {},
  ): Promise<void> {
    nextSeq += 1;
    await dao.recordOnce({
      runId: 'run-a',
      nodeId: null,
      seq: nextSeq,
      occurredAt,
      agentKind: 'claude',
      model: 'claude-opus-5',
      cwd: '/work/project',
      workflowName: null,
      costUsd: 1,
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 5,
      cacheCreationTokens: 1,
      thinkingTokens: 2,
      durationMs: 500,
      apiMs: 400,
      ttftMs: null,
      timeToRequestMs: null,
      numTurns: null,
      ...overrides,
    });
  }

  describe('spend nobody’s turn reported', () => {
    /**
     * A priced cursor run, as the poll leaves its `runs` row. Returned rather
     * than persisted: whether it ALSO sits in the `runs` table is exactly what
     * one of these cases varies.
     */
    function pricedRun(overrides: Partial<Run> = {}): Run {
      return Object.assign(new Run(), {
        id: 'run-cursor',
        agentKind: 'cursor-agent',
        model: 'kimi-k3',
        cwd: '/work/project',
        status: 'completed',
        polledCostCents: 250,
        updatedAt: new Date(2026, 7, 10, 9),
        ...overrides,
      });
    }

    /**
     * File a run's polled spend in the ledger, as the recorder does. The agent
     * is the one the recorder RESOLVES (`polledAgentKind`) — a workflow run
     * names none of its own — so a case that files one says which.
     */
    async function recordPolled(
      run: Run,
      agentKind: AgentKind | null = run.agentKind,
    ): Promise<void> {
      const rows = polledSpendRows(run, agentKind);
      if (rows.length === 0) {
        throw new Error('the fixture run carries no polled spend');
      }
      await dao.recordPolledSpend(run.id, rows);
    }

    /** The cursor turn a poll's price belongs to — unpriced on its own wire. */
    function recordCursorTurn(): Promise<void> {
      return record(new Date(2026, 7, 10, 9), {
        runId: 'run-cursor',
        agentKind: 'cursor-agent',
        model: 'kimi-k3',
        costUsd: null,
        inputTokens: null,
        outputTokens: null,
      });
    }

    it('counts the account poll’s price, which no turn carries', async () => {
      // cursor-agent prices nothing on its own wire, so its money reaches this
      // app only through an account poll. Without that price the page answers
      // `costUsd: null` for cursor however much its runs have spent, and
      // disagrees with Cursor's own dashboard.
      await recordCursorTurn();
      await recordPolled(pricedRun());

      const stats = await readUsage(
        new Date(2026, 7, 10),
        new Date(2026, 7, 12),
      );

      // The money reaches the headline…
      expect(stats.totals.costUsd).toBe(2.5);
      // …and the AGENT row, which is what the report was about.
      expect(
        stats.byAgent.find((g) => g.key === 'cursor-agent')?.totals.costUsd,
      ).toBe(2.5);
      // …and the day, so the chart still sums to the headline.
      expect(
        stats.days.find((d) => d.totals.costUsd !== null)?.totals.costUsd,
      ).toBe(2.5);
      // The polled row is money and not a turn: the one real turn counts once…
      expect(stats.totals.turns).toBe(1);
      // …and IS costed now: `costedTurns` is the denominator of cost-per-turn
      // and excluded this turn only because its price was unknown.
      expect(stats.totals.costedTurns).toBe(1);
    });

    it('places a polled bill on the DAYS it was spent and under the MODELS that spent it', async () => {
      // One row per run put a month of a workflow's cursor bill on its last
      // day under no model — the "By model" list's largest entry was a blank.
      await recordCursorTurn();
      await recordPolled(
        pricedRun({
          polledCostCents: 250,
          polledSpendBuckets: JSON.stringify({
            '2026-08-10|grok-4.7-xhigh': 200,
            '2026-08-11|kimi-k3-max': 50,
          }),
        }),
      );

      const stats = await readUsage(
        new Date(2026, 7, 10),
        new Date(2026, 7, 12),
      );

      expect(stats.totals.costUsd).toBe(2.5);
      expect(stats.days.map((d) => [d.date, d.totals.costUsd])).toEqual([
        ['2026-08-10', 2],
        ['2026-08-11', 0.5],
      ]);
      expect(
        stats.byModel
          .filter((g) => g.key !== 'kimi-k3')
          .map((g) => [g.key, g.totals.costUsd]),
      ).toEqual([
        ['grok-4.7-xhigh', 2],
        ['kimi-k3-max', 0.5],
      ]);
      // The bill is spread over the run's ONE unpriced turn once, not once per
      // row — a cost per turn that divided by it twice would be half the truth.
      expect(stats.totals.costedTurns).toBe(1);
    });

    it('counts a LIVE run’s price once — from the ledger, never the run row', async () => {
      // While the run exists its total sits in two places: the run row the
      // poll writes and the ledger row copied from it. Reading both is a bill
      // at double; reading the run is a bill that vanishes with it.
      const run = pricedRun();
      const em = orm.em.fork();
      em.persist(run);
      await em.flush();
      await recordCursorTurn();
      await recordPolled(run);

      const stats = await readUsage(
        new Date(2026, 7, 10),
        new Date(2026, 7, 12),
      );

      expect(stats.totals.costUsd).toBe(2.5);
    });

    it('files a workflow run’s price under its own thread', async () => {
      // A workflow run's cursor bill was once left out of the per-workflow
      // breakdown for want of a key matching the ledger's, so its rows stopped
      // summing to the headline. The polled row is keyed by its own run.
      await recordPolled(
        pricedRun({
          agentKind: null,
          model: null,
          workflowId: 'dev-team',
          workflowSnapshot: workflowSnapshotOf({
            name: 'Dev Team',
            nodes: [],
            edges: [],
          }),
        }),
        AgentKind.CursorAgent,
      );

      const stats = await readUsage(
        new Date(2026, 7, 10),
        new Date(2026, 7, 12),
      );

      expect(
        stats.byThread.map((group) => [group.key, group.totals.costUsd]),
      ).toEqual([['run-cursor', 2.5]]);
      // The CLI the recorder resolved, since a workflow run names no agent.
      expect(stats.byAgent.map((row) => row.key)).toEqual(['cursor-agent']);
    });

    it('divides a workflow’s polled money over the turns of the CLI that polls, not over an unpriced turn of one that does not', async () => {
      // A cursor node, whose money reaches this app through an account poll, and
      // a codex node, whose turns carry no cost and which no poll covers. Both
      // leave unpriced turns in the ledger, but the run's polled bill is for
      // cursor's alone — counting codex's as costed would spread cursor's money
      // over turns it never paid for.
      //
      // Shaped as the recorder writes a workflow: the run names no agent, model
      // or folder of its own (each node names its agent and model; `cwd` lives
      // on the run and is null for a graph), so the polled fold files the run
      // under the NULL model and project buckets.
      const when = new Date(2026, 7, 10, 9);
      const unpriced: Partial<UsageEventInput> = {
        runId: 'run-wf',
        cwd: null,
        workflowName: 'dev-team',
        costUsd: null,
      };
      await record(when, {
        ...unpriced,
        agentKind: 'cursor-agent',
        model: 'kimi-k3',
      });
      await record(when, {
        ...unpriced,
        agentKind: 'cursor-agent',
        model: 'kimi-k3',
      });
      await record(when, { ...unpriced, agentKind: 'codex', model: 'gpt-5.6' });
      await record(when, { ...unpriced, agentKind: 'codex', model: 'gpt-5.6' });
      await record(when, { ...unpriced, agentKind: 'codex', model: 'gpt-5.6' });
      await recordPolled(
        pricedRun({
          id: 'run-wf',
          agentKind: null,
          model: null,
          cwd: null,
          workflowId: 'dev-team',
          polledCostCents: 300,
          updatedAt: when,
        }),
        AgentKind.CursorAgent,
      );

      const stats = await readUsage(
        new Date(2026, 7, 10),
        new Date(2026, 7, 12),
      );

      expect(stats.totals.costUsd).toBe(3);
      // The headline, and each bucket the polled row is filed under, divide the
      // bill over cursor's two turns.
      expect(stats.totals.costedTurns).toBe(2);
      expect(
        stats.days.find((day) => day.date === '2026-08-10')?.totals.costedTurns,
      ).toBe(2);
      expect(
        stats.byModel.find((row) => row.key === null)?.totals.costedTurns,
      ).toBe(2);
      expect(
        stats.byProject.find((row) => row.key === null)?.totals.costedTurns,
      ).toBe(2);
      // And the per-agent rows agree with them: codex's turns stay unmeasured.
      const byAgent = new Map(
        stats.byAgent.map((row) => [row.key, row.totals]),
      );
      expect(byAgent.get('cursor-agent')?.costedTurns).toBe(2);
      expect(byAgent.get('codex')?.costedTurns).toBe(0);
      expect(byAgent.get('codex')?.costUsd).toBeNull();
    });

    it('leaves an unpriced turn whose agent the ledger does not know out of a polled run’s share', async () => {
      // A row naming no agent — a turn recorded with neither a node nor a run to
      // say which CLI ran it — cannot be shown to belong to one whose money is
      // polled, so the run's polled bill is not spread over it.
      const when = new Date(2026, 7, 10, 9);
      const unpriced: Partial<UsageEventInput> = {
        runId: 'run-wf',
        cwd: null,
        workflowName: 'dev-team',
        costUsd: null,
      };
      await record(when, {
        ...unpriced,
        agentKind: 'cursor-agent',
        model: 'kimi-k3',
      });
      await record(when, { ...unpriced, agentKind: null, model: null });
      await recordPolled(
        pricedRun({
          id: 'run-wf',
          agentKind: null,
          model: null,
          cwd: null,
          workflowId: 'dev-team',
          polledCostCents: 300,
          updatedAt: when,
        }),
        AgentKind.CursorAgent,
      );

      const stats = await readUsage(
        new Date(2026, 7, 10),
        new Date(2026, 7, 12),
      );

      expect(stats.totals.costUsd).toBe(3);
      expect(stats.totals.costedTurns).toBe(1);
      const byAgent = new Map(
        stats.byAgent.map((row) => [row.key, row.totals]),
      );
      expect(byAgent.get('cursor-agent')?.costedTurns).toBe(1);
      expect(byAgent.get(null)?.costedTurns).toBe(0);
    });

    it('costs every unpriced turn of a chat on a polled CLI, in each bucket its money reaches', async () => {
      // The single-agent counterpart, which the per-CLI counting must leave as
      // it was: a chat's run names its agent, so every unpriced turn on it is
      // the polled CLI's.
      const when = new Date(2026, 7, 10, 9);
      const unpriced: Partial<UsageEventInput> = {
        runId: 'run-chat',
        agentKind: 'cursor-agent',
        model: 'kimi-k3',
        cwd: '/work/chat',
        workflowName: null,
        costUsd: null,
      };
      await record(when, unpriced);
      await record(when, unpriced);
      await recordPolled(
        pricedRun({
          id: 'run-chat',
          cwd: '/work/chat',
          polledCostCents: 250,
          updatedAt: when,
        }),
      );

      const stats = await readUsage(
        new Date(2026, 7, 10),
        new Date(2026, 7, 12),
      );

      expect(stats.totals.costedTurns).toBe(2);
      expect(
        stats.days.find((day) => day.date === '2026-08-10')?.totals.costedTurns,
      ).toBe(2);
      expect(
        stats.byAgent.find((row) => row.key === 'cursor-agent')?.totals
          .costedTurns,
      ).toBe(2);
      expect(
        stats.byModel.find((row) => row.key === 'kimi-k3')?.totals.costedTurns,
      ).toBe(2);
      expect(
        stats.byProject.find((row) => row.key === '/work/chat')?.totals
          .costedTurns,
      ).toBe(2);
      expect(
        stats.byThread.find((row) => row.key === 'run-chat')?.totals
          .costedTurns,
      ).toBe(2);
    });

    it('leaves a run alone when its poll recorded nothing', async () => {
      // A cursor run the poll has never priced — no Keychain item, a signed-out
      // account, no network — has no polled row, and must read as unmeasured
      // rather than as free.
      await recordCursorTurn();

      const stats = await readUsage(
        new Date(2026, 7, 10),
        new Date(2026, 7, 12),
      );

      expect(stats.totals.costUsd).toBeNull();
      expect(stats.totals.costedTurns).toBe(0);
    });
  });

  describe('totals', () => {
    it('sums every turn in the period', async () => {
      await record(new Date(2026, 7, 10, 9));
      await record(new Date(2026, 7, 11, 9), { costUsd: 2.5 });

      const stats = await readUsage(
        new Date(2026, 7, 10),
        new Date(2026, 7, 12),
      );

      expect(stats.totals).toMatchObject({
        turns: 2,
        costUsd: 3.5,
        inputTokens: 200,
        workedMs: 1_000,
      });
    });

    it('keeps a total null when nothing in the period reported it', async () => {
      // The cursor-agent shape: tokens, no cost.
      await record(new Date(2026, 7, 10, 9), {
        agentKind: 'cursor-agent',
        costUsd: null,
        durationMs: null,
      });

      const stats = await readUsage(
        new Date(2026, 7, 10),
        new Date(2026, 7, 11),
      );

      expect(stats.totals.costUsd).toBeNull();
      expect(stats.totals.workedMs).toBeNull();
      expect(stats.totals.inputTokens).toBe(100);
    });

    it('counts a turn on the lower bound and excludes one on the upper', async () => {
      const from = new Date(2026, 7, 10, 0, 0, 0);
      const to = new Date(2026, 7, 11, 0, 0, 0);
      await record(from);
      await record(to);

      const stats = await readUsage(from, to);

      // Half-open, so two adjacent periods never both claim the boundary turn
      // and no day is counted twice across a paged read.
      expect(stats.totals.turns).toBe(1);
    });
  });

  describe('days', () => {
    it('emits one bucket per calendar day, including days with no turns', async () => {
      await record(new Date(2026, 7, 10, 9));
      await record(new Date(2026, 7, 12, 9));

      const stats = await readUsage(
        new Date(2026, 7, 10),
        new Date(2026, 7, 13),
      );

      expect(stats.days.map((day) => day.date)).toEqual([
        '2026-08-10',
        '2026-08-11',
        '2026-08-12',
      ]);
      // The quiet day is present and empty — without it the chart would draw
      // the 10th and the 12th as adjacent.
      expect(stats.days[1]!.totals).toMatchObject({ turns: 0, costUsd: null });
    });

    it('buckets a turn by its LOCAL day', async () => {
      // Late evening local time — a UTC-keyed bucket would file this under the
      // 11th for anyone east of Greenwich.
      await record(new Date(2026, 7, 10, 23, 30));

      const stats = await readUsage(
        new Date(2026, 7, 10),
        new Date(2026, 7, 11),
      );

      expect(stats.days).toHaveLength(1);
      expect(stats.days[0]).toMatchObject({
        date: '2026-08-10',
        totals: { turns: 1 },
      });
    });

    it('sums several turns on the same day into one bucket', async () => {
      await record(new Date(2026, 7, 10, 9));
      await record(new Date(2026, 7, 10, 17), { costUsd: 4 });

      const stats = await readUsage(
        new Date(2026, 7, 10),
        new Date(2026, 7, 11),
      );

      expect(stats.days[0]!.totals).toMatchObject({ turns: 2, costUsd: 5 });
    });
  });

  describe('breakdowns', () => {
    it('groups by agent, model and project, dearest first', async () => {
      await record(new Date(2026, 7, 10, 9), {
        agentKind: 'claude',
        model: 'claude-opus-5',
        cwd: '/work/a',
        workflowName: null,
        costUsd: 1,
      });
      await record(new Date(2026, 7, 10, 10), {
        agentKind: 'cursor-agent',
        model: 'composer-1',
        cwd: '/work/b',
        workflowName: null,
        costUsd: 5,
      });

      const stats = await readUsage(
        new Date(2026, 7, 10),
        new Date(2026, 7, 11),
      );

      expect(stats.byAgent.map((group) => group.key)).toEqual([
        'cursor-agent',
        'claude',
      ]);
      expect(stats.byAgent[0]!.totals.costUsd).toBe(5);
      expect(stats.byModel.map((group) => group.key)).toEqual([
        'composer-1',
        'claude-opus-5',
      ]);
      expect(stats.byProject.map((group) => group.key)).toEqual([
        '/work/b',
        '/work/a',
      ]);
    });

    it('ranks by turn count when no slice reported a cost', async () => {
      await record(new Date(2026, 7, 10, 9), { cwd: '/work/a', costUsd: null });
      await record(new Date(2026, 7, 10, 10), {
        cwd: '/work/b',
        workflowName: null,
        costUsd: null,
      });
      await record(new Date(2026, 7, 10, 11), {
        cwd: '/work/b',
        workflowName: null,
        costUsd: null,
      });

      const stats = await readUsage(
        new Date(2026, 7, 10),
        new Date(2026, 7, 11),
      );

      // Without the turn-count tiebreak these come back in map-insertion order,
      // so /work/a would lead despite being the smaller slice.
      expect(stats.byProject.map((group) => group.key)).toEqual([
        '/work/b',
        '/work/a',
      ]);
    });

    it('leaves an unknown dimension null for the client to label', async () => {
      await record(new Date(2026, 7, 10, 9), {
        agentKind: null,
        model: null,
        cwd: null,
      });

      const stats = await readUsage(
        new Date(2026, 7, 10),
        new Date(2026, 7, 11),
      );

      // Never a daemon-invented "(unknown)" string the UI would have to parse
      // back out.
      expect(stats.byAgent[0]!.key).toBeNull();
      expect(stats.byModel[0]!.key).toBeNull();
      expect(stats.byProject[0]!.key).toBeNull();
    });

    it('splits spend by THREAD, titled from its run, and says so when the thread is gone', async () => {
      // REPORTED: the per-workflow breakdown pooled every chat into one row.
      // What a reader brings here is which conversations cost the most —
      // chats and workflow runs alike — and a deleted one keeps its spend.
      const em = orm.em.fork();
      em.persist(
        Object.assign(new Run(), {
          id: 'run-titled',
          title: 'Fix the parser',
          status: 'completed',
        }),
      );
      await em.flush();
      await record(new Date(2026, 7, 10, 9), {
        runId: 'run-titled',
        costUsd: 5,
      });
      await record(new Date(2026, 7, 10, 10), {
        runId: 'run-gone',
        costUsd: 3,
      });
      await record(new Date(2026, 7, 10, 11), {
        runId: 'run-titled',
        costUsd: 1,
      });

      const stats = await readUsage(
        new Date(2026, 7, 10),
        new Date(2026, 7, 11),
      );

      expect(
        stats.byThread.map((group) => [
          group.key,
          group.title,
          group.deleted,
          group.totals.costUsd,
        ]),
      ).toEqual([
        ['run-titled', 'Fix the parser', false, 6],
        ['run-gone', null, true, 3],
      ]);
    });
  });

  describe('range resolution', () => {
    it('echoes the resolved range it actually reported on', async () => {
      const from = new Date(2026, 7, 10);
      const to = new Date(2026, 7, 12);

      const stats = await readUsage(from, to);

      expect(stats.from).toBe(from.toISOString());
      expect(stats.to).toBe(to.toISOString());
    });

    it('treats an absent start as the ledger’s own first turn', async () => {
      const earliest = new Date(2026, 6, 1, 8);
      await record(earliest);
      await record(new Date(2026, 7, 10, 9));

      const stats = await readUsage(undefined, new Date(2026, 7, 11));

      expect(stats.from).toBe(earliest.toISOString());
      expect(stats.totals.turns).toBe(2);
    });

    it('falls back to a recent window when the ledger is empty', async () => {
      const to = new Date(2026, 7, 11);

      const stats = await readUsage(undefined, to);

      // Not the epoch: an empty ledger would otherwise open the page on a
      // fifty-year axis with nothing on it.
      expect(stats.days).toHaveLength(30);
      expect(stats.totals.turns).toBe(0);
    });

    it('clamps a start earlier than the ledger to the ledger’s own first turn', async () => {
      await record(new Date(2026, 7, 10, 9));

      const stats = await readUsage(
        new Date(1000, 0, 1),
        new Date(2026, 7, 11),
      );

      // The reply carries one bucket per calendar day in the RESOLVED range, so
      // an unclamped medieval start expands to ~375,000 buckets and a ~69MB
      // body — one authenticated request able to stall the loopback event loop.
      // Clamping to real data bounds the series by how long the app has been
      // recording, and the echoed range says the request was clamped.
      expect(new Date(stats.from).getFullYear()).toBe(2026);
      expect(stats.days.length).toBeLessThan(40);
      expect(stats.totals.turns).toBe(1);
    });

    it('clamps an end far in the FUTURE to now', async () => {
      await record(new Date(2026, 7, 10, 9));

      const stats = await readUsage(undefined, new Date(9999, 11, 31));

      // The mirror of the floor, and the one that was missed: clamping only the
      // lower bound left `?to=9999-12-31` resolving to ~2.9 million day buckets
      // and a ~511MB body — seven times the hole the floor was added to close.
      // Nothing is ever recorded in the future, so the ceiling is now.
      expect(new Date(stats.to).getFullYear()).toBeLessThan(9999);
      expect(stats.days.length).toBeLessThan(400);
    });

    it('answers an empty period for a window entirely in the future', async () => {
      await record(new Date(2026, 7, 10, 9));

      // Well-ordered bounds, both ahead of now — not a caller error, so it must
      // not 400 with "the start is after the end". The ledger simply holds
      // nothing there.
      const stats = await readUsage(
        new Date(3000, 0, 1),
        new Date(3000, 0, 31),
      );

      expect(stats.totals.turns).toBe(0);
      expect(stats.days).toEqual([]);
    });

    it('refuses an unparseable bound instead of matching nothing', async () => {
      await record(new Date(2026, 7, 10, 9));

      // Every comparison against an `Invalid Date` is false, so without the
      // guard this resolves to a period containing no turns — indistinguishable
      // on the page from a fortnight in which nothing was spent.
      await expect(service.usage('the tenth of August')).rejects.toThrow(
        /ISO-8601/,
      );
    });

    it('reports an empty period when the ledger starts after a lone end bound', async () => {
      await record(new Date(2026, 7, 10, 9));

      // The caller named ONE bound, and an absent start means "as far back as
      // the ledger goes" — so an end earlier than the ledger's first turn
      // describes a period in which nothing was spent, not a range the caller
      // got wrong. On an EMPTY ledger the very same request already answers
      // that way (the 30-day fallback), so today the same question is a 400 or
      // a 200 depending on data the caller cannot see.
      const stats = await service.usage(
        undefined,
        new Date(2026, 6, 1).toISOString(),
      );

      expect(stats.totals.turns).toBe(0);
    });

    it('refuses a range that ends before it starts', async () => {
      await expect(
        readUsage(new Date(2026, 7, 12), new Date(2026, 7, 10)),
      ).rejects.toThrow(/must not be after/);
    });
  });
});
