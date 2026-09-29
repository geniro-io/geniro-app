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
import { NodeStateDao } from '../../agents/dao/node-state.dao';
import { RunDao } from '../../agents/dao/run.dao';
import { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import { NodeState } from '../../runs/entity/node-state.entity';
import { Run } from '../../runs/entity/run.entity';
import { UsageEventDao } from '../dao/usage-event.dao';
import { UsageEvent } from '../entity/usage-event.entity';
import type { UsageEventInput } from '../stats.types';
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
  let runDao: RunDao;

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        dbName: ':memory:',
        // `Run` and `NodeState` ride along because the service reads spend that
        // no TURN reported off the run row, and splits a workflow's by node —
        // see its polled-spend fold.
        entities: [UsageEvent, Run, NodeState],
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
    runDao = new RunDao(em);
    service = new StatsService(
      em,
      dao,
      runDao,
      new NodeStateDao(em),
      new AgentAdapterRegistry([
        new ClaudeAdapter(),
        new CursorAcpAdapter({ vocabularyStore: freshVocabularyStore() }),
        new CodexAdapter(),
      ]),
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
    it('counts the account poll recorded on the run row', async () => {
      // cursor-agent prices nothing on its own wire — measured across a real
      // ledger, 0 of 82 cursor turns carry a cost where 3,359 of 3,359 claude
      // turns do — so its money reaches this app only through an account poll
      // that lands on `Run.polledCostCents`. The Stats page reads the LEDGER,
      // so before this it answered `costUsd: null` for cursor over 82 turns
      // while the runs themselves held $215.01 it never looked at. REPORTED as
      // "если посмотреть на курсор дашборда и на мой… они должны совпадать".
      const when = new Date(2026, 7, 10, 9);
      await record(when, {
        runId: 'run-cursor',
        agentKind: 'cursor-agent',
        model: 'kimi-k3',
        costUsd: null,
        inputTokens: null,
        outputTokens: null,
      });
      const em = orm.em.fork();
      em.create(
        Run,
        {
          id: 'run-cursor',
          agentKind: 'cursor-agent',
          model: 'kimi-k3',
          cwd: '/work/project',
          status: 'completed',
          polledCostCents: 250,
          updatedAt: when,
        },
        { partial: true },
      );
      await em.flush();

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
      // The TURN is not counted twice — the ledger already holds it.
      expect(stats.totals.turns).toBe(1);
      // But it IS costed now: `costedTurns` is the denominator of cost-per-turn
      // and excluded this turn only because its price was unknown.
      expect(stats.totals.costedTurns).toBe(1);
    });

    it('credits a WORKFLOW run’s polled money to the CLI of each node that spent it', async () => {
      // A workflow run names no agent of its own, so its run row cannot say
      // whose money it holds — the per-node shares the poll records beside it
      // do. What the shares do not cover goes to the unknown-agent row rather
      // than to a CLI that did not necessarily spend it.
      const when = new Date(2026, 7, 10, 9);
      await record(when, {
        runId: 'run-wf',
        agentKind: 'cursor-agent',
        costUsd: null,
      });
      await record(when, { runId: 'run-wf', agentKind: 'claude', costUsd: 1 });
      const em = orm.em.fork();
      em.create(
        Run,
        {
          id: 'run-wf',
          agentKind: null,
          workflowId: 'dev-team',
          status: 'completed',
          polledCostCents: 300,
          updatedAt: when,
        },
        { partial: true },
      );
      em.create(
        NodeState,
        {
          runId: 'run-wf',
          nodeId: 'qa',
          status: 'completed',
          agentKind: 'cursor-agent',
          polledCostCents: 250,
        },
        { partial: true },
      );
      await em.flush();

      const stats = await readUsage(
        new Date(2026, 7, 10),
        new Date(2026, 7, 12),
      );

      const byAgent = new Map(
        stats.byAgent.map((row) => [row['key'], row.totals]),
      );
      expect(byAgent.get('cursor-agent')?.costUsd).toBe(2.5);
      // The cursor turn the ledger left unpriced is costed on cursor's row, and
      // claude's own priced turn is untouched by the polled money.
      expect(byAgent.get('cursor-agent')?.costedTurns).toBe(1);
      expect(byAgent.get('claude')?.costUsd).toBe(1);
      expect(byAgent.get(null)?.costUsd).toBeCloseTo(0.5, 10);
      expect(stats.totals.costUsd).toBeCloseTo(4, 10);
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
      const em = orm.em.fork();
      em.create(
        Run,
        {
          id: 'run-wf',
          agentKind: null,
          workflowId: 'dev-team',
          status: 'completed',
          polledCostCents: 300,
          updatedAt: when,
        },
        { partial: true },
      );
      em.create(
        NodeState,
        {
          runId: 'run-wf',
          nodeId: 'qa',
          status: 'completed',
          agentKind: 'cursor-agent',
          polledCostCents: 300,
        },
        { partial: true },
      );
      await em.flush();

      const stats = await readUsage(
        new Date(2026, 7, 10),
        new Date(2026, 7, 12),
      );

      expect(stats.totals.costUsd).toBe(3);
      // The headline, and each bucket the run row files the bill under, divide
      // it over cursor's two turns.
      expect(stats.totals.costedTurns).toBe(2);
      expect(
        stats.days.find((day) => day.date === '2026-08-10')?.totals.costedTurns,
      ).toBe(2);
      expect(
        stats.byModel.find((group) => group.key === null)?.totals.costedTurns,
      ).toBe(2);
      expect(
        stats.byProject.find((group) => group.key === null)?.totals.costedTurns,
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
      const em = orm.em.fork();
      em.create(
        Run,
        {
          id: 'run-wf',
          agentKind: null,
          workflowId: 'dev-team',
          status: 'completed',
          polledCostCents: 300,
          updatedAt: when,
        },
        { partial: true },
      );
      em.create(
        NodeState,
        {
          runId: 'run-wf',
          nodeId: 'qa',
          status: 'completed',
          agentKind: 'cursor-agent',
          polledCostCents: 300,
        },
        { partial: true },
      );
      await em.flush();

      const stats = await readUsage(
        new Date(2026, 7, 10),
        new Date(2026, 7, 12),
      );

      expect(stats.totals.costUsd).toBe(3);
      expect(stats.totals.costedTurns).toBe(1);
      const byAgent = new Map(
        stats.byAgent.map((group) => [group.key, group.totals]),
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
      const em = orm.em.fork();
      em.create(
        Run,
        {
          id: 'run-chat',
          agentKind: 'cursor-agent',
          model: 'kimi-k3',
          cwd: '/work/chat',
          status: 'completed',
          polledCostCents: 250,
          updatedAt: when,
        },
        { partial: true },
      );
      await em.flush();

      const stats = await readUsage(
        new Date(2026, 7, 10),
        new Date(2026, 7, 12),
      );

      expect(stats.totals.costUsd).toBe(2.5);
      expect(stats.totals.costedTurns).toBe(2);
      expect(
        stats.days.find((day) => day.date === '2026-08-10')?.totals.costedTurns,
      ).toBe(2);
      expect(
        stats.byAgent.find((group) => group.key === 'cursor-agent')?.totals
          .costedTurns,
      ).toBe(2);
      expect(
        stats.byModel.find((group) => group.key === 'kimi-k3')?.totals
          .costedTurns,
      ).toBe(2);
      expect(
        stats.byProject.find((group) => group.key === '/work/chat')?.totals
          .costedTurns,
      ).toBe(2);
      expect(
        stats.byWorkflow.find((group) => group.key === null)?.totals
          .costedTurns,
      ).toBe(2);
    });

    it('leaves a run alone when its poll recorded nothing', async () => {
      // A cursor run the poll has never priced — no Keychain item, a signed-out
      // account, no network — must read as unmeasured rather than as free.
      const when = new Date(2026, 7, 10, 9);
      await record(when, {
        runId: 'run-cursor',
        agentKind: 'cursor-agent',
        costUsd: null,
      });
      const em = orm.em.fork();
      em.create(
        Run,
        {
          id: 'run-cursor',
          agentKind: 'cursor-agent',
          status: 'completed',
          polledCostCents: null,
          updatedAt: when,
        },
        { partial: true },
      );
      await em.flush();

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

    it('splits spend by workflow, keeping chats as their own row', async () => {
      // The comparison this breakdown exists for: what the graphs cost
      // against what plain chats cost. A chat's null key is a REAL row
      // here, not an absence — dropping it would leave the workflow shares
      // reading as shares of everything, when they are shares of the graph
      // runs alone.
      await record(new Date(2026, 7, 10, 9), {
        workflowName: 'Nightly review',
        costUsd: 5,
      });
      await record(new Date(2026, 7, 10, 10), {
        workflowName: null,
        costUsd: 3,
      });
      await record(new Date(2026, 7, 10, 11), {
        workflowName: 'Nightly review',
        costUsd: 1,
      });

      const stats = await readUsage(
        new Date(2026, 7, 10),
        new Date(2026, 7, 11),
      );

      expect(
        stats.byWorkflow.map((group) => [group.key, group.totals.costUsd]),
      ).toEqual([
        ['Nightly review', 6],
        [null, 3],
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
