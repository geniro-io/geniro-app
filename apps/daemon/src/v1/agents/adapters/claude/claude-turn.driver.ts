import type { AgentEvent, TurnDriver, TurnIo } from '../adapter.types';
import {
  CLAUDE_CONTROL_REQUEST_ID_PREFIX,
  CLAUDE_MCP_NOT_READY_MESSAGE,
  CLAUDE_MCP_READY_DEADLINE_MS,
  CLAUDE_MCP_READY_EMPTY_GRACE_MS,
  CLAUDE_MCP_READY_POLL_MS,
  CLAUDE_MCP_READY_REPLY_TIMEOUT_MS,
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
    const deadline = startedAt + CLAUDE_MCP_READY_DEADLINE_MS;
    let previousKey: string | null = null;
    let sawServers = false;
    let pending: string[] = [];

    while (now() < deadline) {
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
    return this.deps.mapMessage(obj);
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
