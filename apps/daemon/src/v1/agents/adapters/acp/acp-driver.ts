import { asArray, asNumber, asRecord, asString } from '../../utils/json-util';
import type {
  AgentEvent,
  AgentTurnInput,
  AgentUsage,
  TurnDriver,
  TurnIo,
} from '../adapter.types';
import {
  ACP_AGENT_METHODS,
  ACP_CLIENT_METHODS,
  ACP_PROTOCOL_VERSION,
  ACP_STOP_REASONS,
  type AcpAgentCapabilities,
  type AcpMcpServerHttp,
  type AcpPermissionOption,
  type AcpPermissionOptionKind,
  type AcpStopReason,
  type AcpToolCall,
  type AcpUsageSnapshot,
} from './acp.types';
import {
  classifyMessage,
  decodeRequestId,
  encodeError,
  encodeRequest,
  encodeRequestId,
  encodeResult,
  JSONRPC_METHOD_NOT_FOUND,
  type JsonRpcId,
} from './acp-jsonrpc';

/** What we sent, so the reply can be routed without a callback map. */
type PendingKind = 'initialize' | 'session' | 'set_mode' | 'prompt';

/** A permission verdict this turn can reach without asking the user. */
export type AutoDecision = 'allow' | 'deny' | null;

export interface AcpDriverOptions {
  /** The turn being driven — prompt, cwd, resume id, MCP endpoint. */
  input: AgentTurnInput;
  /** Advertised to the agent as `clientInfo`. */
  clientName: string;
  clientVersion: string;
  /**
   * Resolve a permission request without the user. `null` surfaces an
   * `approval_request` event and parks the agent until a verdict arrives —
   * which is a capability the legacy `cursor-agent -p --force` path never had.
   */
  autoDecide: (toolCall: AcpToolCall) => AutoDecision;
  /** Session mode to request after the session exists, when the agent offers it. */
  preferredModeId?: string | null;
  /**
   * Turn-level degrades the ADAPTER detected before the handshake began — a
   * requested capability ACP has no way to express. Emitted with the rest of
   * the startup events so they reach the transcript on the same path as the
   * driver's own notices.
   */
  startupNotices?: string[];
  logger?: { warn(message: string): void; debug?(message: string): void };
}

function textOf(content: unknown): string | null {
  const block = asRecord(content);
  if (!block || asString(block.type) !== 'text') {
    return null;
  }
  const text = asString(block.text);
  return text !== null && text.length > 0 ? text : null;
}

function readToolCall(source: Record<string, unknown>): AcpToolCall {
  return {
    toolCallId: asString(source.toolCallId) ?? '',
    // `name` is the machine identifier; `title` is the human label every ACP
    // tool call carries. Prefer the former, fall back so the transcript row is
    // never blank.
    name: asString(source.name) ?? asString(source.title) ?? '',
    status: (asString(source.status) as AcpToolCall['status']) ?? null,
    kind: asString(source.kind),
    rawInput: source.rawInput ?? null,
    rawOutput: source.rawOutput ?? null,
  };
}

function readPermissionOptions(value: unknown): AcpPermissionOption[] {
  const options: AcpPermissionOption[] = [];
  for (const entry of asArray(value)) {
    const record = asRecord(entry);
    const optionId = record ? asString(record.optionId) : null;
    const kind = record ? asString(record.kind) : null;
    if (record && optionId !== null && kind !== null) {
      options.push({
        optionId,
        name: asString(record.name) ?? optionId,
        kind: kind as AcpPermissionOptionKind,
      });
    }
  }
  return options;
}

/**
 * Pick the option to answer a permission request with. Only `*_once` kinds are
 * eligible: selecting an `*_always` option would persist a decision beyond the
 * turn that the user was never asked to make at that scope. Returns null when
 * the agent offered nothing matching, which the caller reports as a `cancelled`
 * outcome rather than guessing.
 */
export function selectPermissionOption(
  options: AcpPermissionOption[],
  allow: boolean,
): string | null {
  const wanted: AcpPermissionOptionKind = allow ? 'allow_once' : 'reject_once';
  return options.find((option) => option.kind === wanted)?.optionId ?? null;
}

/**
 * Drives ONE ACP turn over the child's stdin/stdout: the client-initiated
 * handshake (`initialize` → `session/new` | `session/load` → optional
 * `session/set_mode` → `session/prompt`), then the agent's `session/update`
 * stream, its `session/request_permission` round-trips, and finally the
 * `session/prompt` reply carrying the stop reason that ends the turn.
 *
 * One instance per turn — it holds the request ids, the session id, the
 * accumulated usage, and the parked permission requests, none of which may be
 * shared across the N concurrent turns one adapter instance serves.
 *
 * Everything inbound is read through the defensive `json-util` accessors: an
 * unrecognized notification, an unparseable update, or a field that moved
 * between CLI versions degrades to "no event", never to a thrown turn.
 */
export class AcpTurnDriver implements TurnDriver {
  private io: TurnIo | null = null;
  private nextRequestId = 1;
  private readonly pending = new Map<JsonRpcId, PendingKind>();
  private capabilities: AcpAgentCapabilities = {
    loadSession: false,
    mcpHttp: false,
  };
  private sessionId: string | null = null;
  /**
   * `session/load` makes the agent REPLAY the whole prior conversation as
   * `session/update` notifications before it replies. Those are history we
   * already have in SQLite — persisting them again would duplicate every past
   * message into the transcript on each resumed turn — so transcript-producing
   * updates are dropped until the load reply lands.
   */
  private replaying = false;
  /**
   * Replay accounting for a resumed turn. `session/load` streams the whole
   * prior conversation back before the prompt can be sent, and nothing in the
   * protocol bounds that volume — so the cost is measured per turn rather than
   * assumed, which is what any decision to avoid `session/load` needs.
   */
  private replayStartedAt: number | null = null;
  private replayedUpdates = 0;
  /** Mode we asked for, so the reply can report an honest failure. */
  private requestedModeId: string | null = null;
  private readonly usage: AcpUsageSnapshot = {
    inputTokens: null,
    outputTokens: null,
    contextUsed: null,
    costAmount: null,
    costCurrency: null,
  };
  private readonly textChunks: string[] = [];
  /** Tool name by ACP toolCallId, so a later update can name its result. */
  private readonly toolNames = new Map<string, string>();
  /**
   * Tool kind by ACP toolCallId. `session/request_permission` may carry a
   * toolCall stub without one, and kind is what `acceptEdits` decides on — so
   * the kind announced on the original `tool_call` update has to survive.
   */
  private readonly toolKinds = new Map<string, string>();
  /** Options offered per parked permission request, keyed by encoded id. */
  private readonly parkedPermissions = new Map<string, AcpPermissionOption[]>();
  /** One notice per turn for unimplemented agent→client requests. */
  private warnedUnsupportedRequest = false;
  /**
   * Whether this turn's call tools were actually registered. Decided in
   * `buildMcpServers` (which needs the negotiated capabilities) and read when
   * the prompt is composed, so the "May call" block and the tools it names are
   * granted or withheld together.
   */
  private callSurfaceGranted = false;

  constructor(private readonly options: AcpDriverOptions) {}

  onStdinReady(io: TurnIo): void {
    this.io = io;
    const events: AgentEvent[] = [];
    for (const message of this.options.startupNotices ?? []) {
      events.push({ type: 'notice', message });
    }
    this.request(
      ACP_AGENT_METHODS.initialize,
      {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: {
          name: this.options.clientName,
          version: this.options.clientVersion,
        },
      },
      'initialize',
      events,
    );
    for (const event of events) {
      io.emit(event);
    }
  }

  onMessage(obj: unknown): AgentEvent[] {
    const message = classifyMessage(obj);
    switch (message.kind) {
      case 'response': {
        const kind = this.pending.get(message.id);
        if (kind === undefined) {
          return [];
        }
        this.pending.delete(message.id);
        return this.onReply(kind, message.result);
      }
      case 'error': {
        const kind = this.pending.get(message.id);
        if (kind === undefined) {
          return [];
        }
        this.pending.delete(message.id);
        return this.onErrorReply(kind, message.message);
      }
      case 'request':
        return this.onAgentRequest(message.id, message.method, message.params);
      case 'notification':
        return this.onNotification(message.method, message.params);
      case 'unknown':
        return [];
    }
  }

  /**
   * Encode a verdict for a parked `session/request_permission`. `updatedInput`
   * is ignored: ACP's permission outcome carries an option choice only, with no
   * channel for a modified tool input (claude's `updatedInput` free-text answer
   * has no ACP counterpart).
   */
  buildApprovalResponse(
    id: string,
    allow: boolean,
    _updatedInput?: unknown,
  ): string | undefined {
    const requestId = decodeRequestId(id);
    const options = this.parkedPermissions.get(id);
    if (requestId === null || options === undefined) {
      return undefined;
    }
    this.parkedPermissions.delete(id);
    const optionId = selectPermissionOption(options, allow);
    return encodeResult(requestId, {
      outcome:
        optionId === null
          ? // The agent offered no `*_once` option in the direction we need.
            // `cancelled` is the only honest answer — it unparks the agent
            // without claiming a permission we cannot express.
            { outcome: 'cancelled' }
          : { outcome: 'selected', optionId },
    });
  }

  // --- outbound -----------------------------------------------------------

  private request(
    method: string,
    params: unknown,
    kind: PendingKind,
    events: AgentEvent[],
  ): void {
    const id = this.nextRequestId++;
    this.pending.set(id, kind);
    if (this.io?.write(encodeRequest(id, method, params)) !== true) {
      this.pending.delete(id);
      events.push({
        type: 'error',
        message: `acp: failed to send ${method} (the agent's stdin is closed)`,
      });
    }
  }

  private reply(id: JsonRpcId, result: unknown): void {
    if (this.io?.write(encodeResult(id, result)) !== true) {
      this.options.logger?.warn(
        `acp: dropped a reply to request ${String(id)} — stdin is closed`,
      );
    }
  }

  // --- inbound ------------------------------------------------------------

  private onReply(kind: PendingKind, result: unknown): AgentEvent[] {
    switch (kind) {
      case 'initialize':
        return this.onInitialized(result);
      case 'session':
        return this.onSessionReady(result);
      case 'set_mode':
        // A mode the agent accepted needs no announcement; a mode it rejected
        // arrives as an error reply instead (see onErrorReply).
        return [];
      case 'prompt':
        return this.onPromptComplete(result);
    }
  }

  private onErrorReply(kind: PendingKind, message: string): AgentEvent[] {
    if (kind === 'set_mode') {
      // A refused mode is a degrade, not a failure: the turn still runs, just
      // in the agent's default mode. Say so rather than silently downgrading.
      return [
        {
          type: 'notice',
          message: `agent declined session mode '${this.requestedModeId ?? ''}': ${message}`,
        },
      ];
    }
    return [{ type: 'error', message: `acp ${kind} failed: ${message}` }];
  }

  private onInitialized(result: unknown): AgentEvent[] {
    const events: AgentEvent[] = [];
    const root = asRecord(result);
    const agentCapabilities = root ? asRecord(root.agentCapabilities) : null;
    const mcpCapabilities = agentCapabilities
      ? asRecord(agentCapabilities.mcpCapabilities)
      : null;
    this.capabilities = {
      loadSession: agentCapabilities?.loadSession === true,
      mcpHttp: mcpCapabilities?.http === true,
    };

    const version = root ? asNumber(root.protocolVersion) : null;
    if (version !== null && version !== ACP_PROTOCOL_VERSION) {
      // Best-effort: the agent named a version we don't implement. Keep going
      // (the methods we use are stable across v1) but leave a trace, because
      // this is the first thing to suspect if the turn behaves oddly.
      events.push({
        type: 'notice',
        message: `agent negotiated ACP protocol version ${version}; this client implements ${ACP_PROTOCOL_VERSION}`,
      });
    }

    const { mcpServers, notice } = this.buildMcpServers();
    if (notice) {
      events.push({ type: 'notice', message: notice });
    }

    const resumeId = this.options.input.resumeSessionId?.trim();
    if (resumeId && this.capabilities.loadSession) {
      this.replaying = true;
      this.replayStartedAt = Date.now();
      this.request(
        ACP_AGENT_METHODS.sessionLoad,
        { sessionId: resumeId, cwd: this.options.input.cwd, mcpServers },
        'session',
        events,
      );
      return events;
    }
    if (resumeId) {
      // Resume was asked for and the agent cannot do it. The turn still runs,
      // but it starts a FRESH conversation — the user must see that their
      // thread's history is not in this turn's context.
      events.push({
        type: 'notice',
        message:
          'agent does not support session/load — this turn starts a fresh session instead of resuming',
      });
    }
    this.request(
      ACP_AGENT_METHODS.sessionNew,
      { cwd: this.options.input.cwd, mcpServers },
      'session',
      events,
    );
    return events;
  }

  /**
   * Build the client-supplied MCP server list. The call token rides an HTTP
   * header inside a stdin JSON-RPC frame — never argv (`ps`-visible) and never
   * a file on disk, which is what both legacy delivery mechanisms had to use.
   */
  private buildMcpServers(): {
    mcpServers: AcpMcpServerHttp[];
    notice: string | null;
  } {
    const endpoint = this.options.input.mcpEndpoint;
    if (!endpoint) {
      return { mcpServers: [], notice: null };
    }
    if (!this.capabilities.mcpHttp) {
      // The awareness block goes with the tools. Leaving it in would instruct
      // the agent to route work through `call_agent` with nothing registered
      // under that name — its callees never run and the turn still reports
      // success, which is exactly what the pre-ACP degrade path prevented.
      this.callSurfaceGranted = false;
      return {
        mcpServers: [],
        notice:
          'agent calls disabled for this turn: the agent does not advertise HTTP MCP support (mcpCapabilities.http), so the callee list was removed from this turn’s instructions too',
      };
    }
    this.callSurfaceGranted = true;
    return {
      mcpServers: [
        {
          type: 'http',
          name: endpoint.serverName,
          url: endpoint.url,
          headers: [
            { name: 'Authorization', value: `Bearer ${endpoint.token}` },
          ],
        },
      ],
      notice: null,
    };
  }

  private onSessionReady(result: unknown): AgentEvent[] {
    const events: AgentEvent[] = [];
    const root = asRecord(result);
    // `session/new` mints an id; `session/load` returns none, because the id is
    // the one we just sent.
    this.sessionId =
      (root ? asString(root.sessionId) : null) ??
      this.options.input.resumeSessionId?.trim() ??
      null;
    this.replaying = false;
    this.reportReplayCost();

    if (this.sessionId === null) {
      return [
        {
          type: 'error',
          message: 'acp session failed: the agent returned no session id',
        },
      ];
    }
    events.push({ type: 'session', sessionId: this.sessionId });

    const modeId = this.pickMode(root);
    if (modeId !== null) {
      this.requestedModeId = modeId;
      this.request(
        ACP_AGENT_METHODS.sessionSetMode,
        { sessionId: this.sessionId, modeId },
        'set_mode',
        events,
      );
    } else if (
      this.options.preferredModeId &&
      !this.offersMode(root, this.options.preferredModeId)
    ) {
      // The turn asked for a mode the agent does not offer. It still runs —
      // but under the agent's current mode, which for a read-only request like
      // `plan` means write access the user believed they had turned off.
      events.push({
        type: 'notice',
        message: `agent does not offer the '${this.options.preferredModeId}' mode — this turn runs under the agent's current mode instead`,
      });
    }

    this.request(
      ACP_AGENT_METHODS.sessionPrompt,
      {
        sessionId: this.sessionId,
        prompt: [{ type: 'text', text: this.composePrompt() }],
      },
      'prompt',
      events,
    );
    return events;
  }

  /**
   * Log what this turn's `session/load` replay actually cost. The prompt is
   * structurally blocked behind it, so this is per-turn latency that grows
   * with thread length — and the volume depends on the agent's own
   * implementation, which is why it is measured rather than extrapolated.
   */
  private reportReplayCost(): void {
    if (this.replayStartedAt === null) {
      return;
    }
    const elapsedMs = Date.now() - this.replayStartedAt;
    this.replayStartedAt = null;
    this.options.logger?.debug?.(
      `acp session/load replayed ${this.replayedUpdates} update(s) in ${elapsedMs}ms before this turn's prompt could be sent`,
    );
  }

  /**
   * ACP carries no system-prompt parameter, so a graph node's role is
   * prepended to the prompt text. The caller's "May call" block joins it only
   * when this turn's call tools were actually registered — `buildMcpServers`
   * decides that, and it runs before the prompt is sent.
   */
  private composePrompt(): string {
    const { systemPrompt, callSurfacePrompt, prompt } = this.options.input;
    return [
      systemPrompt,
      this.callSurfaceGranted ? callSurfacePrompt : null,
      prompt,
    ]
      .filter((part): part is string => Boolean(part))
      .join('\n\n');
  }

  /**
   * The preferred mode, but only when the agent actually offers it and is not
   * already in it. Asking for a mode that isn't in `availableModes` earns an
   * error reply, so check first rather than spend a round-trip to be refused.
   */
  private pickMode(
    sessionResult: Record<string, unknown> | null,
  ): string | null {
    const wanted = this.options.preferredModeId;
    if (!wanted) {
      return null;
    }
    const modes = sessionResult ? asRecord(sessionResult.modes) : null;
    if (!modes) {
      return null;
    }
    if (asString(modes.currentModeId) === wanted) {
      return null;
    }
    return this.offersMode(sessionResult, wanted) ? wanted : null;
  }

  /** Whether the session reply lists `modeId` among its available modes. */
  private offersMode(
    sessionResult: Record<string, unknown> | null,
    modeId: string,
  ): boolean {
    const modes = sessionResult ? asRecord(sessionResult.modes) : null;
    if (!modes) {
      return false;
    }
    if (asString(modes.currentModeId) === modeId) {
      return true;
    }
    return asArray(modes.availableModes).some((entry) => {
      const record = asRecord(entry);
      return record !== null && asString(record.id) === modeId;
    });
  }

  private onPromptComplete(result: unknown): AgentEvent[] {
    const root = asRecord(result);
    const rawStopReason = root ? asString(root.stopReason) : null;
    const stopReason = (ACP_STOP_REASONS as readonly string[]).includes(
      rawStopReason ?? '',
    )
      ? (rawStopReason as AcpStopReason)
      : null;

    if (stopReason === 'cancelled') {
      // A cancelled turn is not a completion — it must not record usage or a
      // final answer downstream nodes would then consume.
      return [{ type: 'turn_cancelled' }];
    }

    const promptUsage = root ? asRecord(root.usage) : null;
    if (promptUsage) {
      this.usage.inputTokens = asNumber(promptUsage.inputTokens);
      this.usage.outputTokens = asNumber(promptUsage.outputTokens);
    }
    const text = this.textChunks.join('');
    return [
      {
        type: 'turn_complete',
        usage: this.buildUsage(),
        stopReason: rawStopReason,
        finalText: text.length > 0 ? text : null,
      },
    ];
  }

  private buildUsage(): AgentUsage {
    return {
      inputTokens: this.usage.inputTokens,
      outputTokens: this.usage.outputTokens,
      // ACP reports context occupancy directly (`UsageUpdate.used`), so unlike
      // the claude adapter there are no cache counters to sum. Fall back to the
      // plain input count when the agent never sent a usage_update.
      contextTokens: this.usage.contextUsed ?? this.usage.inputTokens,
      // The field is `costUsd`: report an amount only when the agent priced the
      // turn in USD, rather than silently relabelling another currency.
      costUsd:
        this.usage.costCurrency?.toUpperCase() === 'USD'
          ? this.usage.costAmount
          : null,
    };
  }

  private onAgentRequest(
    id: JsonRpcId,
    method: string,
    params: unknown,
  ): AgentEvent[] {
    if (method === ACP_CLIENT_METHODS.sessionRequestPermission) {
      return this.onPermissionRequest(id, params);
    }
    // Everything else is a client capability we deliberately did not advertise
    // (`fs/*`, `terminal/*`) or a vendor extension we don't implement
    // (`cursor/ask_question`). A blocking request MUST be answered or the agent
    // parks forever, so refuse it in-protocol — and say so once, since a
    // refused extension can change what the agent is able to do this turn.
    if (
      this.io?.write(
        encodeError(
          id,
          JSONRPC_METHOD_NOT_FOUND,
          `${method} is not implemented by this client`,
        ),
      ) !== true
    ) {
      this.options.logger?.warn(
        `acp: dropped the error reply to ${method} — stdin is closed`,
      );
    }
    if (this.warnedUnsupportedRequest) {
      return [];
    }
    this.warnedUnsupportedRequest = true;
    return [
      {
        type: 'notice',
        message: `agent asked for '${method}', which this client does not implement; it was declined`,
      },
    ];
  }

  private onPermissionRequest(id: JsonRpcId, params: unknown): AgentEvent[] {
    const root = asRecord(params);
    const toolCallRecord = root ? asRecord(root.toolCall) : null;
    // The permission request's own toolCall is a stub: it may omit the kind
    // `acceptEdits` decides on and the name the approval card shows. Both were
    // announced on the `tool_call` update for this id, so fall back to those
    // rather than deciding — or asking the user — on missing information.
    const toolCall = this.withCachedToolFacts(
      readToolCall(toolCallRecord ?? {}),
    );
    const options = readPermissionOptions(root?.options);

    const decision = this.options.autoDecide(toolCall);
    if (decision !== null) {
      const optionId = selectPermissionOption(options, decision === 'allow');
      this.reply(id, {
        outcome:
          optionId === null
            ? { outcome: 'cancelled' }
            : { outcome: 'selected', optionId },
      });
      return [];
    }

    const encodedId = encodeRequestId(id);
    this.parkedPermissions.set(encodedId, options);
    return [
      {
        type: 'approval_request',
        id: encodedId,
        toolName: toolCall.name,
        input: toolCall.rawInput,
      },
    ];
  }

  /** Restore the kind and name cached from this id's `tool_call` update. */
  private withCachedToolFacts(toolCall: AcpToolCall): AcpToolCall {
    const id = toolCall.toolCallId;
    if (id === '') {
      return toolCall;
    }
    return {
      ...toolCall,
      name:
        toolCall.name === '' ? (this.toolNames.get(id) ?? '') : toolCall.name,
      kind: toolCall.kind ?? this.toolKinds.get(id) ?? null,
    };
  }

  private onNotification(method: string, params: unknown): AgentEvent[] {
    if (method !== ACP_CLIENT_METHODS.sessionUpdate) {
      // Vendor notifications (`cursor/update_todos`, `cursor/task`, …) are
      // fire-and-forget by definition — ignoring one is a no-op, not a stall.
      return [];
    }
    const root = asRecord(params);
    const update = root ? asRecord(root.update) : null;
    if (!update) {
      return [];
    }
    return this.onSessionUpdate(asString(update.sessionUpdate), update);
  }

  private onSessionUpdate(
    kind: string | null,
    update: Record<string, unknown>,
  ): AgentEvent[] {
    if (this.replaying) {
      this.replayedUpdates += 1;
    }
    switch (kind) {
      case 'agent_message_chunk': {
        if (this.replaying) {
          return [];
        }
        const text = textOf(update.content);
        if (text === null) {
          return [];
        }
        this.textChunks.push(text);
        return [{ type: 'text', text }];
      }
      case 'agent_thought_chunk': {
        if (this.replaying) {
          return [];
        }
        const text = textOf(update.content);
        return text === null ? [] : [{ type: 'reasoning', text }];
      }
      case 'tool_call': {
        if (this.replaying) {
          return [];
        }
        const toolCall = readToolCall(update);
        this.toolNames.set(toolCall.toolCallId, toolCall.name);
        if (toolCall.kind !== null) {
          this.toolKinds.set(toolCall.toolCallId, toolCall.kind);
        }
        return [
          {
            type: 'tool_call',
            id: toolCall.toolCallId,
            name: toolCall.name,
            input: toolCall.rawInput,
          },
        ];
      }
      case 'tool_call_update': {
        if (this.replaying) {
          return [];
        }
        const toolCall = readToolCall(update);
        // Only a settled tool call closes the pair; `pending`/`in_progress`
        // updates are progress the transcript does not model.
        if (toolCall.status !== 'completed' && toolCall.status !== 'failed') {
          return [];
        }
        return [
          {
            type: 'tool_result',
            id: toolCall.toolCallId,
            name:
              this.toolNames.get(toolCall.toolCallId) ??
              (toolCall.name.length > 0 ? toolCall.name : null),
            result: toolCall.rawOutput ?? update.content ?? null,
            isError: toolCall.status === 'failed',
          },
        ];
      }
      case 'available_commands_update': {
        // The session's invokable set for this cwd — feeds the composer's `/`
        // autocomplete. Useful during a replay too (it is current state, not
        // history), so it is deliberately outside the replay guard.
        const commands = asArray(update.availableCommands)
          .map((entry) => {
            const record = asRecord(entry);
            return record ? asString(record.name) : null;
          })
          .filter((name): name is string => name !== null && name.length > 0);
        return commands.length > 0
          ? [{ type: 'slash_commands', commands }]
          : [];
      }
      case 'usage_update': {
        this.usage.contextUsed =
          asNumber(update.used) ?? this.usage.contextUsed;
        const cost = asRecord(update.cost);
        if (cost) {
          this.usage.costAmount = asNumber(cost.amount);
          this.usage.costCurrency = asString(cost.currency);
        }
        return [];
      }
      default:
        // user_message_chunk (our own prompt echoed back), plan/plan_update,
        // current_mode_update, config_option_update, session_info_update — all
        // real ACP updates this transcript does not model.
        return [];
    }
  }
}
