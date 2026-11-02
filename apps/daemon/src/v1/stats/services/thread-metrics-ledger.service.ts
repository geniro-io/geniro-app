import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import {
  type ItemWire,
  type RunItemEvent,
  StageChangePayloadSchema,
  ThreadOutcomePayloadSchema,
} from '../../agents/chat.types';
import { ItemDao } from '../../agents/dao/item.dao';
import { NodeStateDao } from '../../agents/dao/node-state.dao';
import { RunDao } from '../../agents/dao/run.dao';
import { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import {
  asRecord,
  asString,
  parseJsonColumn,
} from '../../agents/utils/json-util';
import { KeyedChain } from '../../agents/utils/keyed-chain';
import { toolMetricOf } from '../../agents/utils/tool-metric';
import { usageFiguresFrom } from '../../agents/utils/usage-figures';
import type { AgentKind } from '../../runs/runs.types';
import { MetricLedgerDao } from '../dao/metric-ledger.dao';

/** Tool calls held open in memory waiting for their result; the oldest go first past it. */
const OPEN_CALLS_MAX = 20_000;

interface OpenCall {
  name: string;
  kind: string | null;
  at: number;
}

interface RunFacts {
  teamSlug: string | null;
  agentKind: AgentKind | null;
  createdAt: Date;
}

/**
 * Counts the thread metrics as they happen, into ledgers that outlive the run: one
 * `tool_call_events` row per finished tool call (with the MCP server its adapter reads
 * off the tool's name), a `stage` row per stage change, a `call` row per ended
 * agent-to-agent call and a `thread_outcome` row per run. It OBSERVES the item stream,
 * like `RunOutcomeLedgerService`: the agents and teams modules write the rows and
 * cannot depend on this one.
 *
 * Writes of one run are serialized, so a stage's entry time is read after every earlier
 * move of the run was written; a run deleted meanwhile is written nothing.
 */
@Injectable()
export class ThreadMetricsLedgerService implements OnModuleInit {
  private readonly logger = new Logger(ThreadMetricsLedgerService.name);
  private readonly writes = new KeyedChain();
  private readonly open = new Map<string, OpenCall>();
  private readonly runs = new Map<string, RunFacts>();
  private readonly members = new Map<string, AgentKind | null>();

  constructor(
    private readonly em: EntityManager,
    private readonly bus: AgentEventBus,
    private readonly runDao: RunDao,
    private readonly nodeStateDao: NodeStateDao,
    private readonly itemDao: ItemDao,
    private readonly adapters: AgentAdapterRegistry,
    private readonly ledger: MetricLedgerDao,
  ) {}

  onModuleInit(): void {
    this.bus.all().subscribe((event) => {
      this.observe(event);
    });
    this.bus.allDeleted().subscribe((runId) => {
      this.forget(runId);
    });
  }

  /** Handle one row; a write runs behind the run's earlier ones and never throws. */
  observe({ runId, item }: RunItemEvent): Promise<void> {
    switch (item.kind) {
      case 'tool_call':
        this.rememberCall(runId, item);
        return Promise.resolve();
      case 'tool_result':
        return this.queue(runId, () => this.recordToolCall(runId, item));
      case 'stage_change':
        return this.queue(runId, () => this.recordStage(runId, item));
      case 'call_result':
        return this.queue(runId, () => this.recordCall(runId, item));
      case 'thread_outcome':
        return this.queue(runId, () => this.recordThreadOutcome(runId, item));
      default:
        return Promise.resolve();
    }
  }

  private queue(runId: string, work: () => Promise<void>): Promise<void> {
    return this.writes.run(runId, async () => {
      try {
        await work();
      } catch (err) {
        this.logger.warn(
          `run ${runId}: a thread metric was not recorded: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
  }

  private forget(runId: string): void {
    this.writes.forget(runId);
    this.runs.delete(runId);
    const prefix = `${runId}\u0000`;
    for (const key of [...this.open.keys(), ...this.members.keys()]) {
      if (key.startsWith(prefix)) {
        this.open.delete(key);
        this.members.delete(key);
      }
    }
  }

  private rememberCall(runId: string, item: ItemWire): void {
    const payload = asRecord(item.payload);
    const id = asString(payload?.id);
    const name = asString(payload?.name);
    if (
      id === null ||
      name === null ||
      asString(payload?.parentToolUseId) !== null
    ) {
      return;
    }
    if (this.open.size >= OPEN_CALLS_MAX) {
      const oldest = this.open.keys().next().value;
      if (oldest !== undefined) {
        this.open.delete(oldest);
      }
    }
    this.open.set(callKey(runId, item, id), {
      name,
      kind: asString(payload?.toolKind),
      at: Date.parse(item.createdAt),
    });
  }

  private async recordToolCall(runId: string, item: ItemWire): Promise<void> {
    const payload = asRecord(item.payload);
    const id = asString(payload?.id);
    if (id === null || asString(payload?.parentToolUseId) !== null) {
      return;
    }
    const key = callKey(runId, item, id);
    const call =
      this.open.get(key) ?? (await this.callFromRows(runId, item, id));
    this.open.delete(key);
    const name = call?.name ?? asString(payload?.name);
    if (name === null) {
      return;
    }
    const em = this.em.fork();
    const run = await this.runFacts(runId, em);
    if (run === null) {
      return;
    }
    const agentKind = await this.agentOf(runId, item.memberId, run, em);
    const metric = toolMetricOf(
      this.adapters,
      runId,
      agentKind,
      name,
      call?.kind ?? null,
    );
    const at = Date.parse(item.createdAt);
    await this.ledger.insertToolCall(
      {
        runId,
        seq: item.seq,
        occurredAt: new Date(at),
        teamSlug: run.teamSlug,
        memberId: item.memberId,
        agentKind,
        tool: metric.tool,
        mcpServer: metric.server,
        ok: payload?.isError !== true,
        durationMs:
          call === null || !(at >= call.at) ? null : Math.round(at - call.at),
      },
      em,
    );
  }

  /** The call a result answers, read back when it was made before this process saw it. */
  private async callFromRows(
    runId: string,
    result: ItemWire,
    id: string,
  ): Promise<OpenCall | null> {
    const rows = await this.itemDao.rowsByPayloadId(runId, ['tool_call'], [id]);
    const row = rows
      .filter(
        (r) =>
          r.memberId === result.memberId &&
          (r.inCall ?? '') === (result.inCall ?? '') &&
          r.seq < result.seq,
      )
      .sort((a, b) => b.seq - a.seq)[0];
    if (row === undefined) {
      return null;
    }
    const payload = asRecord(parseJsonColumn(row.payload));
    const name = asString(payload?.name);
    return name === null
      ? null
      : {
          name,
          kind: asString(payload?.toolKind),
          at: row.createdAt.getTime(),
        };
  }

  private async recordStage(runId: string, item: ItemWire): Promise<void> {
    const parsed = StageChangePayloadSchema.safeParse(item.payload);
    if (
      !parsed.success ||
      parsed.data.action === 'nudge' ||
      parsed.data.action === 'stalled'
    ) {
      return;
    }
    const change = parsed.data;
    const em = this.em.fork();
    const run = await this.runFacts(runId, em);
    if (run === null) {
      return;
    }
    const occurredAt = new Date(item.createdAt);
    const enteredAt =
      change.action === 'complete'
        ? ((await this.ledger.lastStageMoveAt(runId, item.seq, em)) ??
          run.createdAt)
        : null;
    await this.ledger.insertStage(
      {
        runId,
        seq: item.seq,
        occurredAt,
        teamSlug: run.teamSlug,
        memberId: change.by.kind === 'agent' ? change.by.nodeId : null,
        lead: change.lead ?? null,
        stageId: change.stageId,
        action: change.action,
        enteredAt,
        durationMs:
          enteredAt === null
            ? null
            : Math.max(0, occurredAt.getTime() - enteredAt.getTime()),
      },
      em,
    );
  }

  private async recordCall(runId: string, item: ItemWire): Promise<void> {
    const payload = asRecord(item.payload);
    const callId = asString(payload?.callId);
    const caller = asString(payload?.callerNodeId);
    const callee = asString(payload?.calleeNodeId);
    if (callId === null || caller === null || callee === null) {
      return;
    }
    const em = this.em.fork();
    const run = await this.runFacts(runId, em);
    if (run === null) {
      return;
    }
    const rows = await this.itemDao.rowsOfCall(
      runId,
      callId,
      ['call_started', 'turn_complete'],
      em,
    );
    const started = rows.find((row) => row.kind === 'call_started');
    const turns = rows.filter((row) => row.kind === 'turn_complete');
    const costs = turns.flatMap((row) => {
      const cost = usageFiguresFrom(parseJsonColumn(row.payload))?.costUsd;
      return typeof cost === 'number' ? [cost] : [];
    });
    const endedAt = Date.parse(item.createdAt);
    await this.ledger.insertCall(
      {
        runId,
        seq: item.seq,
        callId,
        occurredAt: new Date(endedAt),
        teamSlug: run.teamSlug,
        caller,
        callee,
        durationMs:
          started === undefined
            ? null
            : Math.max(0, endedAt - started.createdAt.getTime()),
        costUsd: costs.length === 0 ? null : costs.reduce((a, b) => a + b, 0),
        turns: turns.length,
        ok: payload?.status === 'ok',
      },
      em,
    );
  }

  private async recordThreadOutcome(
    runId: string,
    item: ItemWire,
  ): Promise<void> {
    const parsed = ThreadOutcomePayloadSchema.safeParse(item.payload);
    if (!parsed.success) {
      return;
    }
    const em = this.em.fork();
    if ((await this.runFacts(runId, em)) === null) {
      return;
    }
    await this.ledger.upsertThreadOutcome(
      {
        runId,
        seq: item.seq,
        occurredAt: new Date(item.createdAt),
        teamSlug: parsed.data.teamSlug,
        memberId: item.memberId,
        kind: parsed.data.kind,
      },
      em,
    );
  }

  /**
   * The run's team, agent and start, read once (its deletion forgets it); null
   * for a run already gone.
   */
  private async runFacts(
    runId: string,
    em: EntityManager,
  ): Promise<RunFacts | null> {
    const cached = this.runs.get(runId);
    if (cached !== undefined) {
      return cached;
    }
    const [run] = await this.runDao.runFacts([runId], em);
    if (run === undefined) {
      return null;
    }
    const facts = {
      teamSlug: run.teamId,
      agentKind: run.agentKind,
      createdAt: run.createdAt,
    };
    this.runs.set(runId, facts);
    return facts;
  }

  private async agentOf(
    runId: string,
    memberId: string | null,
    run: RunFacts,
    em: EntityManager,
  ): Promise<AgentKind | null> {
    if (memberId === null) {
      return run.agentKind;
    }
    const key = `${runId}\u0000${memberId}`;
    if (this.members.has(key)) {
      return this.members.get(key) ?? null;
    }
    const state = await this.nodeStateDao.getByRunNode(runId, memberId, em);
    const kind = state?.agentKind ?? run.agentKind;
    this.members.set(key, kind);
    return kind;
  }
}

/** A call's key: an ACP CLI numbers its calls from one in every session, so the conversation is part of it. */
function callKey(runId: string, item: ItemWire, id: string): string {
  return `${runId}\u0000${item.memberId ?? ''}\u0000${item.inCall ?? ''}\u0000${id}`;
}
