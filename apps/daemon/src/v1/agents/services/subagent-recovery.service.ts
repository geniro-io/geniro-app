import { EntityManager } from '@mikro-orm/sqlite';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import type { Subscription } from 'rxjs';
import { z } from 'zod';

import { AgentKindSchema, isTerminalRunStatus } from '../../runs/runs.types';
import type { SubagentRecoveryRef } from '../adapters/adapter.types';
import type { RunDelegateState } from '../chat.types';
import { ItemDao } from '../dao/item.dao';
import { RunDao } from '../dao/run.dao';
import { mapEventToItem } from '../utils/event-to-item';
import { itemToWire } from '../utils/item-wire';
import { asRecord, parseJsonColumn, payloadString } from '../utils/json-util';
import { delegateCloseEvent, ownerFields } from '../utils/open-delegates';
import { persistItemAndEmit } from '../utils/persist-item';
import { foldRunDelegates } from '../utils/run-state-folds';
import { AgentAdapterRegistry } from './agent-adapter.registry';
import { AgentEventBus } from './agent-events.bus';
import { AgentSessionRegistry } from './agent-session.registry';
import { ItemCallIndexService } from './item-call-index.service';
import { ItemSeqAllocator } from './item-seq.allocator';

const RETRY_MS = 30_000;
const RecoveryRefSchema = z.object({
  agentKind: AgentKindSchema,
  sessionId: z.string().min(1),
  cwd: z.string().min(1),
  configDir: z.string().nullable(),
  toolCallId: z.string().min(1),
  launchedAtMs: z.number().finite(),
  childSessionId: z.string().nullable(),
});

interface Candidate {
  delegate: RunDelegateState;
  ref: SubagentRecoveryRef;
  version: number;
}

/** Re-read vendor records; every answer is appended through the normal durable stream. */
@Injectable()
export class SubagentRecoveryService
  implements OnModuleInit, OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(SubagentRecoveryService.name);
  private readonly pending = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private flight: Promise<void> | null = null;
  private subscription: Subscription | null = null;
  private stopped = false;

  constructor(
    private readonly em: EntityManager,
    private readonly runs: RunDao,
    private readonly items: ItemDao,
    private readonly adapters: AgentAdapterRegistry,
    private readonly bus: AgentEventBus,
    private readonly seqs: ItemSeqAllocator,
    private readonly calls: ItemCallIndexService,
    private readonly sessions: AgentSessionRegistry,
  ) {}

  onModuleInit(): void {
    this.subscription = this.bus.all().subscribe(({ runId, item }) => {
      if (
        ['subagent_info', 'turn_complete', 'turn_cancelled', 'error'].includes(
          item.kind,
        )
      ) {
        this.schedule(runId);
      }
    });
  }

  async onApplicationBootstrap(): Promise<void> {
    for (const id of await this.items.subagentRecoveryRunIds(this.em.fork())) {
      this.pending.set(id, 0);
    }
    this.arm(0);
  }

  schedule(runId: string): void {
    if (this.stopped) {
      return;
    }
    this.pending.set(runId, (this.pending.get(runId) ?? 0) + 1);
    this.arm(0);
  }

  private arm(delay = RETRY_MS): void {
    if (
      this.stopped ||
      this.timer !== null ||
      this.flight !== null ||
      this.pending.size === 0
    ) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flight = this.sweep().finally(() => {
        this.flight = null;
        this.arm();
      });
    }, delay);
    this.timer.unref();
  }

  private async sweep(): Promise<void> {
    for (const [runId, version] of [...this.pending]) {
      if (this.stopped) {
        return;
      }
      try {
        if (
          !(await this.reconcile(runId)) &&
          this.pending.get(runId) === version
        ) {
          this.pending.delete(runId);
        }
      } catch (error) {
        this.logger.warn(
          `Could not reconcile subagents for ${runId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /** Returns whether an unresolved candidate still needs another read. */
  async reconcile(runId: string): Promise<boolean> {
    const candidates = await this.candidates(runId);
    for (const candidate of candidates) {
      const { delegate, ref } = candidate;
      if (
        this.stopped ||
        this.sessions.subagentRecoveryBlocked(runId, delegate.id)
      ) {
        continue;
      }
      const adapter = this.adapters.for(ref.agentKind);
      const outcome = await adapter.recoverSubagent(ref);
      if (
        outcome === null ||
        this.stopped ||
        this.sessions.subagentRecoveryBlocked(runId, delegate.id)
      ) {
        continue;
      }

      // Reserve before rechecking: a later live event must sort after recovery,
      // and an earlier event still being persisted must finish before we decide.
      const seq = await this.seqs.reserve(runId);
      try {
        if (this.seqs.writtenThrough(runId, seq - 1) < seq - 1) {
          continue;
        }
        const latest = (await this.candidates(runId)).find(
          (entry) => entry.delegate.id === delegate.id,
        );
        if (
          latest?.version !== candidate.version ||
          this.stopped ||
          this.sessions.subagentRecoveryBlocked(runId, delegate.id)
        ) {
          continue;
        }
        const mapped = mapEventToItem(
          delegateCloseEvent(delegate.id, outcome),
        )!;
        await persistItemAndEmit(
          {
            itemDao: this.items,
            bus: this.bus,
            calls: this.calls,
            seqs: this.seqs,
          },
          this.em.fork(),
          {
            runId,
            nodeId: delegate.nodeId,
            seq,
            kind: mapped.kind,
            role: mapped.role,
            payload: { ...mapped.payload, ...ownerFields(delegate) },
          },
        );
      } finally {
        this.seqs.settle(runId, seq);
      }
    }
    return (await this.candidates(runId)).length > 0;
  }

  private async candidates(runId: string): Promise<Candidate[]> {
    const em = this.em.fork();
    const run = await this.runs.getById(runId, em);
    if (run === null || run.archivedAt !== null) {
      return [];
    }
    const declarations = (
      await this.items.rowsOfKinds(runId, ['subagent_info'], undefined, em)
    ).map(itemToWire);
    const refs = new Map<
      string,
      { ref: SubagentRecoveryRef; version: number }
    >();
    for (const row of declarations) {
      const record = asRecord(row.payload);
      const id = payloadString(row.payload, 'id');
      if (id === null) {
        continue;
      }
      if (record?.recovery === null) {
        refs.delete(id);
      }
      const parsed = RecoveryRefSchema.safeParse(record?.recovery);
      if (parsed.success && parsed.data.toolCallId === id) {
        refs.set(id, { ref: parsed.data, version: row.seq });
      } else if (refs.has(id)) {
        refs.get(id)!.version = row.seq;
      }
    }
    if (refs.size === 0) {
      return [];
    }
    const paired = (
      await this.items.rowsByPayloadId(
        runId,
        ['tool_call', 'tool_result'],
        [...refs.keys()],
        undefined,
        em,
      )
    ).map(itemToWire);
    const endings = (
      await this.items.turnEndingsAfter(runId, declarations[0]!.seq, em)
    ).map((row) => ({
      seq: row.seq,
      nodeId: row.nodeId,
      callId: payloadString(parseJsonColumn(row.payload), 'callId'),
    }));
    const delegates = foldRunDelegates({
      declarations,
      launches: paired.filter((row) => row.kind === 'tool_call'),
      replies: paired.filter((row) => row.kind === 'tool_result'),
      runSettled: isTerminalRunStatus(run.status),
      endings,
    });
    // A continued child transcript belongs to its newest launch only.
    const owners = new Map<string, string>();
    for (const [id, { ref }] of refs) {
      if (ref.childSessionId !== null) {
        owners.set(
          JSON.stringify([
            ref.agentKind,
            ref.configDir,
            ref.sessionId,
            ref.childSessionId,
          ]),
          id,
        );
      }
    }
    return delegates.flatMap((delegate) => {
      const recovery = refs.get(delegate.id);
      if (delegate.status !== 'untracked' || recovery === undefined) {
        return [];
      }
      const ref = recovery.ref;
      if (
        ref.childSessionId !== null &&
        owners.get(
          JSON.stringify([
            ref.agentKind,
            ref.configDir,
            ref.sessionId,
            ref.childSessionId,
          ]),
        ) !== delegate.id
      ) {
        return [];
      }
      return [{ delegate, ...recovery }];
    });
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    this.subscription?.unsubscribe();
    if (this.timer !== null) {
      clearTimeout(this.timer);
    }
    await this.flight;
  }
}
