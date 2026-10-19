import { EntityManager } from '@mikro-orm/sqlite';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import type { Subscription } from 'rxjs';

import { isTerminalRunStatus } from '../../runs/runs.types';
import type { SubagentRecoveryRef } from '../adapters/adapter.types';
import type { RunDelegateState } from '../chat.types';
import { ItemDao } from '../dao/item.dao';
import { RunDao } from '../dao/run.dao';
import { mapEventToItem } from '../utils/event-to-item';
import { itemToWire } from '../utils/item-wire';
import { asRecord, payloadString } from '../utils/json-util';
import { delegateCloseEvent, ownerFields } from '../utils/open-delegates';
import { persistItemAndEmit } from '../utils/persist-item';
import { foldRunDelegates, turnEndingOf } from '../utils/run-state-folds';
import { SubagentRecoveryRefSchema } from '../utils/subagent-recovery-ref';
import { AgentAdapterRegistry } from './agent-adapter.registry';
import { AgentEventBus } from './agent-events.bus';
import { AgentSessionRegistry } from './agent-session.registry';
import { ItemCallIndexService } from './item-call-index.service';
import { ItemSeqAllocator } from './item-seq.allocator';

const RECOVERY_DELAYS_MS = [0, 2_000, 10_000] as const;
/** How long after boot recent runs are reconciled — after the daemon listens. */
const RECOVERY_BOOT_DELAY_MS = 5_000;
/**
 * Boot reconciles only runs that recorded a recovery ref this recently. An
 * older run's delegates are reconciled when its chat is next opened.
 */
const RECOVERY_BOOT_WINDOW_MS = 24 * 60 * 60_000;
/**
 * How long a delegate that may still be running stays given up after a round
 * ran out: its CLI can still write the ending, and nothing else re-arms it.
 */
const RECOVERY_GIVE_UP_COOLDOWN_MS = 10 * 60_000;
/** Runs whose retired delegates are remembered; the oldest is forgotten. */
const RECOVERY_RETIRED_RUNS_MAX = 500;

/** The statuses a delegate leaves only through a newer row of its own. */
const SETTLED_DELEGATE_STATUSES: ReadonlySet<RunDelegateState['status']> =
  new Set(['completed', 'failed', 'cancelled']);

interface Candidate {
  delegate: RunDelegateState;
  ref: SubagentRecoveryRef;
  version: number;
}

/** A delegate needing no read at `version` — for good, or until `until`. */
interface Retired {
  version: number;
  until: number | null;
}

interface RecoveryAttempt {
  attempt: number;
  dueAt: number;
}

/** Re-read vendor records; every answer is appended through the normal durable stream. */
@Injectable()
export class SubagentRecoveryService
  implements OnModuleInit, OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(SubagentRecoveryService.name);
  private readonly pending = new Map<string, RecoveryAttempt>();
  /**
   * Per run, the delegates needing no further read at the row version they
   * were seen at: settled, or still unknown when a whole round ran out. A
   * newer `subagent_info` row for the delegate moves its version and re-arms
   * it, and so does the cooldown of one given up while it may still run — so
   * a reconnecting client cannot restart a round more often than that.
   */
  private readonly retired = new Map<string, Map<string, Retired>>();
  /** The candidates the latest {@link reconcile} of a run left unresolved. */
  private readonly unresolved = new Map<string, Candidate[]>();
  private timer: NodeJS.Timeout | null = null;
  private bootTimer: NodeJS.Timeout | null = null;
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
      const payload = asRecord(item.payload);
      const lost =
        item.kind === 'subagent_info' &&
        (payload?.backgroundOutcome === 'untracked' ||
          (payload?.backgroundOpen === false &&
            payload.backgroundOutcome == null));
      if (
        lost ||
        ['turn_complete', 'turn_cancelled', 'error'].includes(item.kind)
      ) {
        this.schedule(runId, true);
      }
    });
  }

  /** Off the boot path: the scan must not hold back the daemon's listen. */
  onApplicationBootstrap(): void {
    this.bootTimer = setTimeout(() => {
      this.bootTimer = null;
      void this.scheduleRecent().catch((error: unknown) => {
        this.logger.warn(
          `Could not list runs to reconcile: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }, RECOVERY_BOOT_DELAY_MS);
    this.bootTimer.unref();
  }

  private async scheduleRecent(): Promise<void> {
    const since = new Date(Date.now() - RECOVERY_BOOT_WINDOW_MS);
    for (const id of await this.items.subagentRecoveryRunIds(
      since,
      this.em.fork(),
    )) {
      this.schedule(id);
    }
  }

  schedule(runId: string, newEvidence = false): void {
    if (this.stopped) {
      return;
    }
    const previous = this.pending.get(runId);
    // Duplicate subscriptions join the current attempt budget. A new loss is
    // fresh evidence and must not disappear behind an in-flight final attempt.
    if (previous !== undefined && !newEvidence) {
      return;
    }
    this.pending.set(runId, {
      attempt: 0,
      dueAt: Date.now(),
    });
    this.arm();
  }

  private arm(): void {
    if (this.stopped || this.flight !== null || this.pending.size === 0) {
      return;
    }
    if (this.timer !== null) {
      clearTimeout(this.timer);
    }
    let dueAt = Number.POSITIVE_INFINITY;
    for (const entry of this.pending.values()) {
      dueAt = Math.min(dueAt, entry.dueAt);
    }
    this.timer = setTimeout(
      () => {
        this.timer = null;
        this.flight = this.sweep().finally(() => {
          this.flight = null;
          this.arm();
        });
      },
      Math.max(0, dueAt - Date.now()),
    );
    this.timer.unref();
  }

  private async sweep(): Promise<void> {
    for (const [runId, entry] of [...this.pending]) {
      if (this.stopped) {
        return;
      }
      if (this.pending.get(runId) !== entry || entry.dueAt > Date.now()) {
        continue;
      }
      let unresolved = true;
      try {
        unresolved = await this.reconcile(runId);
      } catch (error) {
        this.logger.warn(
          `Could not reconcile subagents for ${runId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (this.stopped || this.pending.get(runId) !== entry) {
        continue;
      }
      entry.attempt += 1;
      if (!unresolved || entry.attempt >= RECOVERY_DELAYS_MS.length) {
        this.pending.delete(runId);
        for (const candidate of this.unresolved.get(runId) ?? []) {
          // One whose process ended will write nothing more; one that may
          // still run can, so it is tried again after the cooldown.
          this.retire(
            runId,
            candidate.delegate.id,
            candidate.version,
            candidate.delegate.processEnded
              ? null
              : Date.now() + RECOVERY_GIVE_UP_COOLDOWN_MS,
          );
        }
        this.unresolved.delete(runId);
      } else {
        entry.dueAt = Date.now() + RECOVERY_DELAYS_MS[entry.attempt]!;
      }
    }
  }

  /** Returns whether an unresolved candidate still needs another read. */
  async reconcile(runId: string): Promise<boolean> {
    const candidates = await this.candidates(runId);
    const unresolved: Candidate[] = [];
    // A row was written, or a newer one decided a delegate: what is left has
    // to be read again rather than taken from this pass.
    let reread = false;
    for (const candidate of candidates) {
      const { delegate, ref } = candidate;
      if (
        this.stopped ||
        this.sessions.subagentRecoveryBlocked(runId, delegate.id)
      ) {
        unresolved.push(candidate);
        continue;
      }
      const adapter = this.adapters.for(ref.agentKind);
      const outcome = await adapter.recoverSubagent(ref);
      if (
        outcome === null ||
        this.stopped ||
        this.sessions.subagentRecoveryBlocked(runId, delegate.id)
      ) {
        unresolved.push(candidate);
        continue;
      }

      // Reserve before rechecking: a later live event must sort after recovery,
      // and an earlier event still being persisted must finish before we decide.
      const seq = await this.seqs.reserve(runId);
      try {
        if (this.seqs.writtenThrough(runId, seq - 1) < seq - 1) {
          unresolved.push(candidate);
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
          reread = true;
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
        reread = true;
      } finally {
        this.seqs.settle(runId, seq);
      }
    }
    const remaining = reread ? await this.candidates(runId) : unresolved;
    this.unresolved.set(runId, remaining);
    return remaining.length > 0;
  }

  private retire(
    runId: string,
    id: string,
    version: number,
    until: number | null = null,
  ): void {
    // Re-inserted on every touch, so the map's order is recency and the run
    // forgotten first is the one least recently reconciled.
    const run = this.retired.get(runId) ?? new Map<string, Retired>();
    this.retired.delete(runId);
    if (this.retired.size >= RECOVERY_RETIRED_RUNS_MAX) {
      // Forgetting a run costs one more read of it, never a wrong answer.
      this.retired.delete(this.retired.keys().next().value!);
    }
    this.retired.set(runId, run);
    run.set(id, { version, until });
  }

  private isRetired(
    retired: ReadonlyMap<string, Retired> | undefined,
    id: string,
    version: number,
  ): boolean {
    const entry = retired?.get(id);
    return (
      entry !== undefined &&
      entry.version === version &&
      (entry.until === null || Date.now() < entry.until)
    );
  }

  /**
   * The run's delegates still worth a read, after recording what the read
   * found settled — the one place {@link readCandidates}' findings are
   * applied.
   */
  private async candidates(runId: string): Promise<Candidate[]> {
    const read = await this.readCandidates(runId);
    if (read === null) {
      this.retired.delete(runId);
      return [];
    }
    for (const { id, version } of read.settled) {
      this.retire(runId, id, version);
    }
    return read.open;
  }

  /**
   * What the run's rows say of its recoverable delegates: the ones still
   * unresolved, and the ones they show settled at a version. Null when the run
   * is gone or archived. Reads `retired` and changes nothing.
   */
  private async readCandidates(runId: string): Promise<{
    open: Candidate[];
    settled: { id: string; version: number }[];
  } | null> {
    const em = this.em.fork();
    const run = await this.runs.getById(runId, em);
    if (run === null || run.archivedAt !== null) {
      return null;
    }
    const settled: { id: string; version: number }[] = [];
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
      const parsed = SubagentRecoveryRefSchema.safeParse(record?.recovery);
      if (parsed.success && parsed.data.toolCallId === id) {
        refs.set(id, { ref: parsed.data, version: row.seq });
      } else if (refs.has(id)) {
        refs.get(id)!.version = row.seq;
      }
    }

    // What the declarations alone settle needs none of the run's tool rows: a
    // stated outcome, an open unit, or a version already retired.
    const retired = this.retired.get(runId);
    const open = new Set<string>();
    for (const delegate of foldRunDelegates({
      declarations,
      launches: [],
      replies: [],
      runSettled: true,
    })) {
      const recovery = refs.get(delegate.id);
      if (
        recovery === undefined ||
        this.isRetired(retired, delegate.id, recovery.version)
      ) {
        continue;
      }
      if (SETTLED_DELEGATE_STATUSES.has(delegate.status)) {
        settled.push({ id: delegate.id, version: recovery.version });
      } else if (delegate.status === 'untracked') {
        open.add(delegate.id);
      }
    }
    if (open.size === 0) {
      return { open: [], settled };
    }

    const paired = (
      await this.items.rowsByPayloadId(
        runId,
        ['tool_call', 'tool_result'],
        [...open],
        undefined,
        em,
      )
    ).map(itemToWire);
    const endings = (
      await this.items.turnEndingsAfter(runId, declarations[0]!.seq, em)
    ).map(turnEndingOf);
    const delegates = foldRunDelegates({
      declarations: declarations.filter((row) =>
        open.has(payloadString(row.payload, 'id') ?? ''),
      ),
      launches: paired.filter((row) => row.kind === 'tool_call'),
      replies: paired.filter((row) => row.kind === 'tool_result'),
      runSettled: isTerminalRunStatus(run.status),
      runCancelled: run.status === 'cancelled',
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
    const candidates = delegates.flatMap((delegate) => {
      const recovery = refs.get(delegate.id)!;
      if (SETTLED_DELEGATE_STATUSES.has(delegate.status)) {
        settled.push({ id: delegate.id, version: recovery.version });
        return [];
      }
      if (delegate.status !== 'untracked') {
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
    return { open: candidates, settled };
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    this.subscription?.unsubscribe();
    if (this.timer !== null) {
      clearTimeout(this.timer);
    }
    if (this.bootTimer !== null) {
      clearTimeout(this.bootTimer);
    }
    this.pending.clear();
    await this.flight;
  }
}
