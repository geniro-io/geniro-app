import type { AgentEvent, TurnDriver, TurnIo } from '../adapter.types';
import {
  CLAUDE_CONTROL_REQUEST_ID_PREFIX,
  CLAUDE_MCP_NOT_READY_MESSAGE,
  CLAUDE_MCP_READY_EMPTY_GRACE_MS,
  CLAUDE_MCP_READY_MAX_WAIT_MS,
  CLAUDE_MCP_READY_POLL_MS,
  CLAUDE_MCP_READY_REPLY_TIMEOUT_MS,
  CLAUDE_MCP_READY_STALL_MS,
} from './claude.const';
import {
  type ClaudeMcpStatusRow,
  mcpReadingKey,
  mcpStatusRequestLine,
  pendingMcpServers,
  readMcpStatusReply,
} from './utils/claude-mcp-ready.utils';

/** What the driver needs from the adapter, injected so a spec needs no process. */
export interface ClaudeTurnDriverDeps {
  mapMessage: (obj: unknown) => AgentEvent[];
  buildApprovalResponse: (
    id: string,
    allow: boolean,
    updatedInput?: unknown,
  ) => string | undefined;
  /** Sink for the gate's account of itself; silent by default. */
  logger?: { warn(message: string): void; debug?(message: string): void };
  /** Injected so a spec can run the gate's whole loop in no wall-clock time. */
  now?: () => number;
  delay?: (ms: number) => Promise<void>;
}

/** Resolvers for the one poll currently in flight. */
interface OpenPoll {
  id: string;
  settle: (rows: ClaudeMcpStatusRow[] | 'refused') => void;
}

/**
 * Claude's per-turn protocol driver.
 *
 * Line mapping and verdict encoding are the stateless pair every stream-json
 * CLI needs and are delegated straight back to the adapter. What makes this a
 * driver rather than the base's object literal is {@link awaitPromptReady} —
 * a short client-initiated conversation that has to happen BEFORE the turn's
 * prompt is written, and which therefore holds state (the poll in flight) that
 * must not live on the adapter: one adapter instance drives N concurrent turns
 * under graph fan-out.
 *
 * The gate's reason for existing, the probe evidence behind it and every
 * number it uses are recorded at `CLAUDE_MCP_STATUS_SUBTYPE` in
 * `claude.const.ts`. In one line: the CLI starts its MCP servers when the
 * process starts and does not wait for them, so a turn that begins three
 * seconds in is handed a tool surface with the slower servers missing — and the
 * model, told once that a tool does not exist, spends the rest of the
 * conversation working around a capability it actually has.
 */
export class ClaudeTurnDriver implements TurnDriver {
  private polls = 0;
  private openPoll: OpenPoll | null = null;
  /**
   * What the window holds after a compaction that NOTHING has measured since —
   * or null when the freshest reading is a request's own.
   *
   * Per-turn state, which is why it is here and not on the adapter: one adapter
   * instance drives N concurrent turns under graph fan-out.
   *
   * It exists because a compaction leaves BOTH readings of the window wrong in
   * the same direction. The live one is the prompt of the last request, which
   * was the whole conversation the compaction has just replaced; the durable one
   * is the `result` line's copy of that same request. So a chat that had just
   * gone from 515k to 12.6k went on reporting 515k in the composer's ring — the
   * defect this reads as, and the one the user reported as "after compact the
   * current context wasn't updated".
   *
   * Cleared by the next {@link AgentEvent} `context_progress`, because that IS a
   * measurement of the window and a later one: an AUTO compaction happens mid
   * turn and every request after it reports the real figure, so only a turn that
   * ENDED on its compaction needs this.
   */
  private compactedTo: number | null = null;

  constructor(private readonly deps: ClaudeTurnDriverDeps) {}

  /**
   * Held between the child's stdin being wired and the turn's prompt going out.
   *
   * Never rejects and never runs unbounded: every exit below is a release, and
   * the caller writes the prompt the moment this resolves. A gate that could
   * throw or hang would cost the user their message, which is a far worse
   * failure than the one it is fixing.
   */
  async awaitPromptReady(io: TurnIo): Promise<void> {
    const now = this.deps.now ?? Date.now;
    const startedAt = now();
    const ceiling = startedAt + CLAUDE_MCP_READY_MAX_WAIT_MS;
    let previousKey: string | null = null;
    let sawServers = false;
    let pending: string[] = [];
    // When the reading last CHANGED. The gate gives up on a STALL rather than
    // on a total elapsed time, so a folder whose servers are visibly still
    // coming up keeps its wait while one that is stuck still releases promptly.
    let lastChangeAt = startedAt;

    while (
      now() < ceiling &&
      now() - lastChangeAt < CLAUDE_MCP_READY_STALL_MS
    ) {
      const reading = await this.poll(io);
      if (reading === 'refused') {
        // This CLI will not answer the question, so there is nothing to wait
        // for. Releasing at once is exactly the behaviour that shipped before
        // the gate existed — a renamed subtype costs the fix, never the turn.
        this.deps.logger?.debug?.(
          'claude: mcp readiness unavailable on this CLI — sending the prompt now',
        );
        return;
      }
      pending = pendingMcpServers(reading);
      if (reading.length > 0) {
        sawServers = true;
      }
      const key = mcpReadingKey(reading);
      if (sawServers && pending.length === 0 && key === previousKey) {
        // Two identical readings, not one: a single "nothing pending" is also
        // what a half-discovered list looks like, and releasing on it puts the
        // prompt out mid-discovery — which is the bug.
        this.deps.logger?.debug?.(
          `claude: ${reading.length} MCP server(s) ready after ${now() - startedAt}ms`,
        );
        return;
      }
      if (!sawServers && now() - startedAt >= CLAUDE_MCP_READY_EMPTY_GRACE_MS) {
        // Nothing has ever been reported here, so there is nothing to dial.
        return;
      }
      if (key !== previousKey) {
        // Discovery moved — a server appeared, or one left `pending`. Whatever
        // it did, this folder is not stuck, so the stall window starts again.
        lastChangeAt = now();
      }
      previousKey = key;
      await this.wait(CLAUDE_MCP_READY_POLL_MS);
    }

    if (pending.length > 0) {
      // The turn is about to run without these, which is the old broken
      // behaviour — so it is said out loud rather than left for the user to
      // rediscover as "the agent can't use it".
      io.emit({
        type: 'notice',
        message: CLAUDE_MCP_NOT_READY_MESSAGE.replace('%s', pending.join(', ')),
        // INFO, and this REPLACES an earlier deliberate choice of the advisory
        // (warning) chrome on the grounds that a turn missing tools is a
        // degrade. The degrade is real; the chrome was still wrong, and the
        // user's own report is the evidence — "i see this error", about a turn
        // that had run correctly. Nothing here failed: the servers were slow,
        // the turn ran, they finish dialling behind it and the next message has
        // them, which is exactly what the sentence goes on to say. Reserving the
        // red banner for things that actually went wrong is what keeps it
        // meaning anything.
        severity: 'info',
      });
    }
  }

  onMessage(obj: unknown): AgentEvent[] {
    const open = this.openPoll;
    if (open) {
      const reading = readMcpStatusReply(obj, open.id);
      if (reading !== null) {
        // The gate's own traffic: consumed here, never mapped. A reply nobody
        // asked for reaches `mapMessage` like any other line.
        open.settle(reading);
        return [];
      }
    }
    this.rememberApiFailure(obj);
    return this.deps
      .mapMessage(obj)
      .flatMap((event) => this.trackWindow(event))
      .map((event) => this.withFailureDetail(event));
  }

  /**
   * The provider's own account of a failed request, kept until the `result`
   * line that ends the turn on it.
   *
   * Per-turn state, so it belongs to the driver rather than the adapter (one
   * adapter instance drives N concurrent turns), and it has to be state at all
   * because the two halves arrive on DIFFERENT lines: the request id and the
   * error code ride the synthetic `assistant` line that carries the failure's
   * prose, and the failure itself is only declared one line later. A pure
   * per-line mapper cannot join them, which is why this is here and not there.
   *
   * Probed on 2.1.234 (`--model definitely-not-a-model`):
   *
   *   {"type":"assistant","message":{…"model":"<synthetic>"…},
   *    "error":"model_not_found","request_id":"req_011CeAL4…",
   *    "is_api_error_message":true}
   *
   * `is_api_error_message` is what makes this readable at all: without it the
   * line is indistinguishable from the agent talking, and `request_id` appears
   * on ordinary lines too.
   */
  private apiFailure: { requestId?: string; code?: string } | null = null;

  /** Read the failure facts off a synthetic api-error `assistant` line. */
  private rememberApiFailure(obj: unknown): void {
    if (typeof obj !== 'object' || obj === null) {
      return;
    }
    const line = obj as {
      is_api_error_message?: unknown;
      request_id?: unknown;
      error?: unknown;
    };
    if (line.is_api_error_message !== true) {
      return;
    }
    const requestId =
      typeof line.request_id === 'string' ? line.request_id : undefined;
    const code = typeof line.error === 'string' ? line.error : undefined;
    if (requestId === undefined && code === undefined) {
      return;
    }
    this.apiFailure = {
      ...(requestId ? { requestId } : {}),
      ...(code ? { code } : {}),
    };
  }

  /**
   * Hand the remembered facts to the error event the turn ends on.
   *
   * The result line's own reading WINS where both have one — it describes the
   * turn's ending, while this describes a request that may have been retried —
   * and the id is only ever here, which is the whole reason for keeping it.
   * Consumed once: a second failure in the same turn reports its own facts or
   * none, never the previous one's.
   */
  private withFailureDetail(event: AgentEvent): AgentEvent {
    if (event.type !== 'error' || this.apiFailure === null) {
      return event;
    }
    const remembered = this.apiFailure;
    this.apiFailure = null;
    return {
      ...event,
      detail: {
        ...(remembered.code ? { code: remembered.code } : {}),
        ...(remembered.requestId ? { requestId: remembered.requestId } : {}),
        ...event.detail,
      },
    };
  }

  /**
   * Keep the turn's account of the window honest across a compaction — see
   * {@link compactedTo}.
   *
   * Two things happen to a finished compaction that reported what it left
   * behind: the figure is announced on the live plane at once (a
   * `context_progress` is exactly "how full the window is now", so the composer's
   * ring drops as the compaction lands instead of at the next request), and it
   * is stamped onto this turn's `turn_complete` so a reopened chat reads the
   * same number rather than the pre-compaction one the CLI's `result` carries.
   *
   * A compaction that reported NO `post_tokens` — 2.1.228 sends it only
   * sometimes — changes nothing here. The reading is then simply unknown, and
   * inventing one is the single thing a context meter must never do.
   *
   * MAIN THREAD ONLY, like the `context_progress` the mapper emits and for the
   * same reason: a delegate's context is its own, and the meter reports the
   * conversation.
   */
  private trackWindow(event: AgentEvent): AgentEvent[] {
    if (event.parentToolUseId !== undefined) {
      return [event];
    }
    if (event.type === 'context_progress') {
      this.compactedTo = null;
      return [event];
    }
    if (event.type === 'context_compacted' && event.phase === 'finished') {
      const post = event.postTokens;
      if (post === null || post <= 0) {
        return [event];
      }
      this.compactedTo = post;
      return [event, { type: 'context_progress', contextTokens: post }];
    }
    if (
      event.type === 'turn_complete' &&
      event.usage !== null &&
      this.compactedTo !== null
    ) {
      return [
        {
          ...event,
          usage: { ...event.usage, contextTokens: this.compactedTo },
        },
      ];
    }
    return [event];
  }

  buildApprovalResponse(
    id: string,
    allow: boolean,
    updatedInput?: unknown,
  ): string | undefined {
    return this.deps.buildApprovalResponse(id, allow, updatedInput);
  }

  /**
   * One request/reply round trip.
   *
   * A write the transport refuses resolves `'refused'`: a dialogue that cannot
   * be held is the same as one this CLI does not know. A reply that does not
   * arrive in time resolves an EMPTY reading instead — silence is "we do not
   * know yet", and the empty grace is what bounds it (see
   * {@link CLAUDE_MCP_READY_REPLY_TIMEOUT_MS} for the run that made the
   * difference matter).
   */
  private poll(io: TurnIo): Promise<ClaudeMcpStatusRow[] | 'refused'> {
    const id = `${CLAUDE_CONTROL_REQUEST_ID_PREFIX}mcp-${++this.polls}`;
    return new Promise((resolve) => {
      let done = false;
      const settle = (reading: ClaudeMcpStatusRow[] | 'refused'): void => {
        if (done) {
          return;
        }
        done = true;
        this.openPoll = null;
        resolve(reading);
      };
      this.openPoll = { id, settle };
      if (!io.write(mcpStatusRequestLine(id))) {
        settle('refused');
        return;
      }
      void this.wait(CLAUDE_MCP_READY_REPLY_TIMEOUT_MS).then(() => settle([]));
    });
  }

  private wait(ms: number): Promise<void> {
    if (this.deps.delay) {
      return this.deps.delay(ms);
    }
    return new Promise((resolve) => {
      // Unref'd: a pending poll timer must never be the reason node stays up.
      setTimeout(resolve, ms).unref();
    });
  }
}
