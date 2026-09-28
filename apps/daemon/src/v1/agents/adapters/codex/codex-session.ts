import type { SessionLogger } from '../../utils/spawn-cli';
import type {
  AgentEvent,
  AgentTurnInput,
  FollowUpMessage,
  TurnDriver,
  TurnIo,
} from '../adapter.types';
import {
  classifyMessage,
  encodeNotification,
  encodeRequest,
  encodeResult,
  type JsonRpcId,
} from '../utils/json-rpc.utils';
import { CODEX_INITIALIZED_NOTIFICATION, CODEX_METHODS } from './codex.const';
import type { CodexItem, CodexTokenUsage } from './codex.types';
import {
  type CodexPendingKind,
  CodexTurnDriver,
  type CodexTurnOptions,
} from './codex-turn.driver';
import { codexInitializeParams } from './utils/codex-handshake.utils';
import { subagentState } from './utils/codex-items.utils';

/** What a {@link CodexSession} needs from the adapter that built it. */
export interface CodexSessionOptions {
  clientVersion: string;
  /** Everything about one turn, from that turn's own input — never captured. */
  turnOptions: (input: AgentTurnInput) => CodexTurnOptions;
  logger?: SessionLogger;
}

/**
 * ONE `codex app-server` process and the turns run on it — the `TurnDriver`
 * the codex adapter returns.
 *
 * The SESSION half of the protocol state: the transport, the request-id
 * counter and its pending map, the thread every turn runs in, the model it is
 * on, and everything keyed by an id codex mints for the whole thread (items,
 * parked requests, sub-agent threads). A fresh {@link CodexTurnDriver} holds
 * each turn's own state, so nothing of one message leaks into the next.
 */
export class CodexSession implements TurnDriver {
  /**
   * The child's stdin/stdout, re-set on every turn: `spawn-cli` hands a fresh
   * `TurnIo` per turn whose `emit` routes to the turn now open.
   */
  private io: TurnIo | null = null;
  /** The codex thread this conversation is — its session id. */
  threadId: string | null = null;
  /** The model the thread runs on, as codex last stated it. */
  threadModel: string | null = null;
  /** The newest token reading — the window's size between turns. */
  lastUsage: CodexTokenUsage | null = null;
  /**
   * Items by id, from their start to their completion — a file-change
   * approval names only its item, and the changes it asks about are on that
   * item's start.
   */
  readonly items = new Map<string, CodexItem>();
  /**
   * Server requests awaiting the user's verdict, by encoded id. Thread-scoped
   * rather than per-turn: a request left unanswered when its turn settles is
   * re-offered to the next turn, and its verdict has to find it there.
   */
  readonly parked = new Map<string, { method: string; params: unknown }>();
  /** A sub-agent's thread → the collab call that spawned it. */
  readonly subagents = new Map<string, string>();
  /** Spawning calls whose delegate this session has announced as running. */
  private readonly openSubagents = new Set<string>();
  /**
   * The thread is in plan mode, as codex last confirmed it. codex keeps a
   * turn's collaboration mode for the turns after it — across processes too,
   * since it is saved on the thread — so the turn that leaves plan mode has to
   * say so. Moved only by what codex answered ({@link notePlanMode}).
   */
  private inPlanMode = false;

  private nextRequestId = 1;
  /**
   * Frames awaiting a reply and the turn that sent each. A reply owed to a
   * turn that has since ended is dropped rather than handed to the turn that
   * replaced it.
   */
  private readonly pending = new Map<
    JsonRpcId,
    { kind: CodexPendingKind; turn: CodexTurnDriver }
  >();
  private turn: CodexTurnDriver;

  constructor(
    private readonly options: CodexSessionOptions,
    firstTurn: AgentTurnInput,
  ) {
    this.turn = new CodexTurnDriver(this, options.turnOptions(firstTurn));
  }

  /**
   * The FIRST turn's opening: the handshake, then the thread, then — once the
   * thread's id is back — the prompt. Written back to back without waiting:
   * codex reads one ordered stream.
   */
  onStdinReady(io: TurnIo): void {
    this.io = io;
    const events: AgentEvent[] = [];
    this.request(
      CODEX_METHODS.initialize,
      codexInitializeParams(this.options.clientVersion),
      'initialize',
      events,
    );
    this.write(encodeNotification(CODEX_INITIALIZED_NOTIFICATION, {}));
    this.turn.openThread(events);
    for (const event of events) {
      io.emit(event);
    }
  }

  /**
   * A SECOND (or later) turn on the live thread — `TurnDriver.openTurn`. TOTAL:
   * a throw here would unwind past a turn `spawn-cli` has already registered.
   */
  openTurn(io: TurnIo, input: AgentTurnInput): void {
    this.io = io;
    const events: AgentEvent[] = [];
    try {
      this.turn = new CodexTurnDriver(this, this.options.turnOptions(input));
      this.turn.beginTurn(events);
    } catch (err) {
      events.push({
        type: 'error',
        message: `codex: could not open this turn: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    }
    for (const event of events) {
      io.emit(event);
    }
  }

  onMessage(obj: unknown): AgentEvent[] {
    const message = classifyMessage(obj);
    switch (message.kind) {
      case 'response': {
        const entry = this.takePending(message.id);
        return entry === null
          ? []
          : entry.turn.onReply(entry.kind, message.result);
      }
      case 'error': {
        const entry = this.takePending(message.id);
        return entry === null
          ? []
          : entry.turn.onErrorReply(entry.kind, message.message);
      }
      case 'request':
        return this.turn.onServerRequest(
          message.id,
          message.method,
          message.params,
        );
      case 'notification':
        return this.turn.onNotification(message.method, message.params);
      case 'unknown':
        return [];
    }
  }

  buildApprovalResponse(
    id: string,
    allow: boolean,
    updatedInput?: unknown,
  ): string | undefined {
    return this.turn.buildApprovalResponse(id, allow, updatedInput);
  }

  sendFollowUp(message: FollowUpMessage): boolean {
    return this.turn.sendFollowUp(message);
  }

  buildInterruptPayload(): string | undefined {
    return this.turn.buildInterruptPayload();
  }

  /**
   * The collaboration mode a turn must carry, or null when it needs none.
   *
   * Sent only on the way INTO plan mode and on the way back out: a mode on
   * every turn would also send a `default` settings block, and codex lets a
   * collaboration mode's settings take precedence over the thread's own.
   */
  collaborationModeFor(
    plan: boolean,
    model: string | null,
    effort: string | null,
  ): Record<string, unknown> | null {
    if (plan === this.inPlanMode) {
      return null;
    }
    const settingsModel = model ?? this.threadModel;
    if (settingsModel === null) {
      return null;
    }
    return {
      mode: plan ? 'plan' : 'default',
      settings: {
        model: settingsModel,
        reasoning_effort: effort,
        developer_instructions: null,
      },
    };
  }

  /**
   * Record the collaboration mode codex confirmed — a thread's reply naming it,
   * or a `turn/start` that carried a switch and was accepted. A refused switch
   * leaves the thread where it was, so it records nothing.
   */
  notePlanMode(plan: boolean): void {
    this.inPlanMode = plan;
  }

  /**
   * End one sub-agent: announce its spawning call closed, once, with how it
   * ended — whichever report of its ending arrives first.
   */
  closeSubagent(
    threadId: string,
    outcome: 'completed' | 'failed',
  ): AgentEvent[] {
    const parent = this.subagents.get(threadId);
    if (parent === undefined || !this.openSubagents.delete(parent)) {
      return [];
    }
    return [subagentState(parent, { open: false, outcome })];
  }

  /** Mark a spawning call's delegate as running, so its ending is owed. */
  openSubagent(spawnItemId: string): void {
    this.openSubagents.add(spawnItemId);
  }

  /**
   * Run `step` for `turn` after `ms`, emitting what it produces — unless
   * another turn has opened by then or the process can no longer be written
   * to (stopped, or exited), when nothing is listening for what it would say.
   */
  schedule(
    turn: CodexTurnDriver,
    ms: number,
    step: (events: AgentEvent[]) => void,
  ): void {
    const timer = setTimeout(() => {
      const io = this.io;
      if (this.turn !== turn || io === null || io.writeObstacle?.()) {
        return;
      }
      const events: AgentEvent[] = [];
      step(events);
      for (const event of events) {
        io.emit(event);
      }
    }, ms);
    timer.unref?.();
  }

  // ── Outbound ──────────────────────────────────────────────────────────────

  /** Send one request, answering whether it actually went out. */
  request(
    method: string,
    params: unknown,
    kind: CodexPendingKind,
    events: AgentEvent[],
  ): boolean {
    const id = this.nextRequestId++;
    this.pending.set(id, { kind, turn: this.turn });
    if (this.io?.write(encodeRequest(id, method, params)) !== true) {
      this.pending.delete(id);
      events.push({
        type: 'error',
        message: `codex: failed to send ${method}${this.writeFailure()}`,
      });
      return false;
    }
    return true;
  }

  /**
   * A request frame for the CALLER to write — registered as pending first, so
   * the reply to it is recognised.
   */
  frame(method: string, params: unknown, kind: CodexPendingKind): string {
    const id = this.nextRequestId++;
    this.pending.set(id, { kind, turn: this.turn });
    return encodeRequest(id, method, params);
  }

  /** Answer one server request. */
  reply(id: JsonRpcId, result: unknown): void {
    if (this.io?.write(encodeResult(id, result)) !== true) {
      this.log(
        `codex: dropped a reply to request ${String(id)}${this.writeFailure()}`,
      );
    }
  }

  /** Write a frame this class did not build. */
  write(payload: string): boolean {
    return this.io?.write(payload) === true;
  }

  log(message: string): void {
    this.options.logger?.warn(message);
  }

  /** " — <cause>" for a write that did not land, as the writer names it. */
  private writeFailure(): string {
    const obstacle = this.io?.writeObstacle?.() ?? null;
    return obstacle === null ? '' : ` — ${obstacle}`;
  }

  private takePending(
    id: JsonRpcId,
  ): { kind: CodexPendingKind; turn: CodexTurnDriver } | null {
    const entry = this.pending.get(id);
    if (entry === undefined) {
      return null;
    }
    this.pending.delete(id);
    if (entry.turn !== this.turn) {
      this.log(
        `codex: dropped the reply to request ${String(id)} (${entry.kind}) — the turn that sent it has already ended`,
      );
      return null;
    }
    return entry;
  }
}
