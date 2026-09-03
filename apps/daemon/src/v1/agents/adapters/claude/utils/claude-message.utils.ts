import { errorDetail } from '../../../utils/error-detail';
import {
  asArray,
  asBoolean,
  asNumber,
  asRecord,
  asString,
} from '../../../utils/json-util';
import type {
  AgentEvent,
  AgentMcpServer,
  AgentMcpServerStatus,
  AgentUsage,
  BackgroundUnitUsage,
  WorkflowAgentSnapshot,
} from '../../adapter.types';
import {
  CLAUDE_ABORTED_TERMINAL_REASONS,
  CLAUDE_COMPACT_BOUNDARY_SUBTYPE,
  CLAUDE_COMPACT_FAILED_NOTICE,
  CLAUDE_COMPACT_RESULT_FAILED,
  CLAUDE_COMPACTING_STATUS,
  CLAUDE_PERMISSION_CHANNEL_FAILURE_MARKERS,
  CLAUDE_PERMISSION_CHANNEL_FAILURE_NOTICE,
  CLAUDE_RUN_FAILED_MESSAGE,
  CLAUDE_STATUS_SUBTYPE,
  CLAUDE_TASK_NOTIFICATION_SUBTYPE,
  CLAUDE_TASK_PROGRESS_SUBTYPE,
  CLAUDE_TASK_STARTED_SUBTYPE,
  CLAUDE_TASK_TERMINAL_STATUSES,
  CLAUDE_TASK_TYPE_AGENT,
  CLAUDE_TASK_TYPE_WORKFLOW,
  CLAUDE_TASK_UPDATED_SUBTYPE,
  CLAUDE_TURN_ABORTED_MESSAGE,
  CLAUDE_WORKFLOW_AGENT_ENTRY,
  CLAUDE_WORKFLOW_AGENT_STATES,
} from '../claude.const';
import { readCommandsChanged } from './claude-commands.utils';
import {
  claudeTaskEventFromToolResult,
  claudeTaskEventFromToolUse,
} from './claude-tasks.utils';
import {
  type ClaudeSessionCostLedger,
  readClaudeAssistantContext,
  readClaudeUsage,
} from './claude-usage.utils';

/**
 * Whether a tool result is the CLI reporting that its permission channel died,
 * rather than the tool itself failing.
 *
 * Defensive about the SHAPE as well as the text: `content` is a string on some
 * results and an array of blocks on others, and the marker has been observed in
 * both. Anything with no text leaf carries no prose, so it does not match.
 *
 * Deliberately NOT a search of the serialized payload. Both markers must appear
 * in ONE text leaf: the CLI writes them as a single sentence, so a match spread
 * across two unrelated blocks — or found inside an image block's base64 — would
 * be a false positive, and serializing that base64 to look for prose it cannot
 * contain was the cost this replaced.
 */
/**
 * Whether an `assistant` line is the CLI reporting a FAILED REQUEST rather than
 * the agent talking.
 *
 * This CLI ships such a report in the ordinary assistant envelope — same
 * `type`, same `message.content[].text` — so without the flag the two are
 * indistinguishable, and `request_id` is no help because it rides ordinary
 * lines too. Read off the author's own session store, where 55 of them are
 * recorded across four codes:
 *
 *   {"type":"assistant","error":"server_error","is_api_error_message":true,
 *    "message":{"content":[{"type":"text",
 *      "text":"API Error: Connection closed mid-response. …"}]}}
 *
 * The `error` code is `server_error` (connection closed / stalled / timed out /
 * 529 / ENOTFOUND), `rate_limit` ("You've hit your weekly limit · resets 4pm"),
 * or `authentication_failed` — and the flag is the ONE thing common to all of
 * them, which is why the predicate reads it and never the prose.
 *
 * The wire spells it `is_api_error_message`; the session JSONL spells the same
 * fact `isApiErrorMessage`. Only the wire spelling is read here — this mapper
 * is fed stdout, and `claude-sessions.utils.ts` owns the file's envelope.
 *
 * ONE spelling for the daemon's two readers: this mapper, which turns the line
 * into a `notice`, and `ClaudeTurnDriver.rememberApiFailure`, which keeps the
 * code and the request id for the error the turn may end on.
 */
export function isClaudeApiErrorLine(obj: unknown): boolean {
  const root = asRecord(obj);
  return root !== null && root.is_api_error_message === true;
}

export function isPermissionChannelFailure(content: unknown): boolean {
  if (typeof content === 'string') {
    return hasFailureMarkers(content);
  }
  // Only a TEXT leaf can carry the CLI's sentence. Serializing the whole
  // payload to find two short markers cost a full `JSON.stringify` per
  // tool_result on the per-event path — and the worst case is not a large
  // `Read` but an IMAGE result, whose base64 was stringified in its entirety to
  // search it for prose it cannot contain.
  if (Array.isArray(content)) {
    return content.some((block) => {
      const text = asString(asRecord(block)?.text);
      return text !== null && hasFailureMarkers(text);
    });
  }
  const text = asString(asRecord(content)?.text);
  return text !== null && hasFailureMarkers(text);
}

/**
 * Both halves on the leaf's FIRST non-empty line — which is the CLI's whole
 * sentence, not a document that happens to quote it.
 *
 * Requiring them merely to co-occur somewhere in the leaf made this fire on any
 * tool result that MENTIONS the markers, and the commonest such result is a
 * `Read` of geniro's own source: `claude.const.ts` names both markers, and
 * `spawn-cli.ts` quotes the CLI's sentence verbatim in a doc block. Measured on
 * a real 47-minute run — 12 matches in the daemon log, every one of them
 * geniro's own prose being read back, and not a single genuine CLI failure
 * among them. The user saw three "claude could not reach its permission
 * channel" rows for sub-agents that were simply reading this file.
 *
 * The first line is the discriminator because the failing tool's result IS the
 * sentence: it arrives alone, so it is line one. A file that documents the
 * markers has them on some later line, behind the content above them.
 */
function hasFailureMarkers(text: string): boolean {
  const firstLine = text.split('\n').find((line) => line.trim() !== '');
  if (firstLine === undefined) {
    return false;
  }
  return CLAUDE_PERMISSION_CHANNEL_FAILURE_MARKERS.every((marker) =>
    firstLine.includes(marker),
  );
}

/**
 * Whether a `result` line reports NOTHING — no stop reason, no final text, and
 * not one non-zero token or cost figure.
 *
 * The CLI emits such a line at the START of a resumed turn, seconds after the
 * user's message and before any output of that turn (observed on 2.1.222,
 * twice, each time on the turn following one that used `run_in_background`).
 * Taken at face value it is a turn completion, and the damage is threefold:
 * the transcript grows a `✓ done · $0.0000` footer directly under the user's
 * message, the context meter reads the zeros and drops to `0 of 200k`, and —
 * worst — the turn is marked terminated, so the REAL work that follows is
 * never given a completion of its own and its cost never counted.
 *
 * A completion that reports no work is not a completion. Dropping it lets the
 * turn run on, and `ChatService`'s no-terminal-event fallback still writes a
 * terminal item when the process actually settles, so no client is left
 * waiting. The test is deliberately narrow — every genuine completion observed
 * carries `stop_reason: 'end_turn'` plus real token counts — so a legitimate
 * result can never be silently discarded by it.
 *
 * **An EMPTY `result` string is no text, and reading it as text is what let two
 * of these through.** Reconstructed from the author's own `geniro.db` and debug
 * log (2026-08-18, 2.1.234, run `4144f28e`, twice within 40 minutes): the user
 * sent `status?`, and 2.7s later the turn settled on a line whose every figure
 * was zero — `✓ done · 0s · $0.0000` under their message, with no answer above
 * it. Cross-checked against the CLI's OWN session file, the turn it actually
 * ran in that window was not the user's prompt at all but a `<task-notification>`
 * it had queued for itself (`<status>stopped</status>`, from a delegate started
 * in an earlier turn), and it produced nothing for it. So the line was the
 * absence of an answer in every sense — and only `result: ""` rather than
 * `result: null` kept it out of this guard. The user's own prompt was answered
 * ten seconds later, on a turn geniro had already declared finished, which is
 * how it reached them as "I periodically get errors like this".
 *
 * The next reader's lead, unprobed here: such a line reportedly names itself —
 * `origin:{kind:"task-notification"}` (see `CLAUDE_TASK_STARTED_SUBTYPE`). That
 * would say WHY the line is not ours instead of inferring it from zeros, and it
 * is worth reading off a live capture before it is written into code.
 */
function describesNoWork(
  usage: AgentUsage,
  stopReason: string | null,
  finalText: string | null,
): boolean {
  if (stopReason !== null || (finalText !== null && finalText.trim() !== '')) {
    return false;
  }
  return (
    !usage.inputTokens &&
    !usage.outputTokens &&
    !usage.costUsd &&
    usage.contextTokens === null &&
    usage.contextWindowTokens === null
  );
}

/**
 * The statuses claude's `system/init` reports a loaded MCP server in.
 *
 * `disabled` is one of them — a switched-off server IS still reported, it is
 * simply reported as off. PROBE-VERIFIED on 2.1.223, isolated
 * `CLAUDE_CONFIG_DIR`, one `local`-scope server:
 *
 *   without `disabledMcpServers` → `[{name:'probe-server', status:'failed'}]`
 *   with it                      → `[{name:'probe-server', status:'disabled'}]`
 *
 * matching the 2.1.222 probe recorded at {@link CLAUDE_HOME_DISABLED_MCP_KEY}.
 * The `projects` key is matched on the RESOLVED path, so an entry under
 * `/tmp/...` is not read for a cwd the CLI resolves to `/private/tmp/...` —
 * worth knowing before trusting a re-probe that seems to disagree.
 *
 * Keeping the status here is load-bearing rather than tidy: an unrecognised one
 * degrades to `unknown`, and where the CLI's own config cannot be read the panel
 * falls back to `status === 'disabled'` to decide whether a row is off. A
 * `disabled` row arriving as `unknown` therefore renders as ON.
 *
 * Anything still unrecognised degrades to `unknown` rather than being dropped —
 * the server is real either way, and a status this mapper could not read is not
 * a reason to hide it from the panel.
 *
 * A MAP rather than a set, because the CLI and this app do not spell the
 * sign-in state alike: init says `needs-auth` and `AgentMcpServerStatus` says
 * `needs_auth`. It was a set of the four this app already spelled identically,
 * so that row fell through to `unknown` — and unknown is the one status with no
 * affordance on it, which is exactly the state a server the user has to sign in
 * to must not be shown in. REPORTED as an MCP panel of "a lot of unknown ones",
 * and it is most of the list rather than an edge: measured on the reporter's own
 * harvest, 27 of 51 rows in one folder, 28 of 53 in another.
 *
 * MEASURED rather than read off the binary — the literal is in there, but among
 * spellcheck and github strings, which says nothing about this field. One real
 * `claude -p --output-format stream-json --verbose` on 2.1.251, reading the
 * `system/init` line's own `mcp_servers`:
 *
 *   {'pending': 3, 'connected': 8, 'needs-auth': 1}
 *   {name: 'claude.ai Wispr Flow', status: 'needs-auth'}
 *
 * `loading` is deliberately NOT here: it is cursor's own sixth status, and
 * nothing has observed claude reporting one. This map holds what this CLI was
 * seen to send.
 */
const INIT_STATUSES: Readonly<Record<string, AgentMcpServerStatus>> = {
  connected: 'connected',
  failed: 'failed',
  pending: 'pending',
  disabled: 'disabled',
  'needs-auth': 'needs_auth',
};

/**
 * What one background unit spent, off a `system/task_notification` line.
 *
 * Undefined — never a record of nulls — when the line carries no `usage` block
 * at all, which is what a non-terminal notification and an older CLI both look
 * like. The consumer merges these announcements by preferring the last non-null
 * field, so an all-null record would be harmless; `undefined` is nonetheless
 * the honest shape for "this line said nothing about it" and keeps the
 * lifecycle event's own field optional.
 *
 * The key names are the CLI's (`total_tokens` / `tool_uses` / `duration_ms`),
 * read off a live 2.1.237 delegation rather than from any document. There is no
 * cost among them, and not for want of looking — see `subagent_info.tokens`.
 */
function readClaudeTaskUsage(
  root: Record<string, unknown>,
): BackgroundUnitUsage | undefined {
  const usage = asRecord(root.usage);
  if (usage === null) {
    return undefined;
  }
  return {
    tokens: asNumber(usage.total_tokens),
    toolUses: asNumber(usage.tool_uses),
    durationMs: asNumber(usage.duration_ms),
  };
}

/**
 * One delegate's bill, off the `tool_use_result` riding the `user` line that
 * closes its launching `Task` call.
 *
 * This is the ONLY channel that breaks a delegate's spend down by token kind
 * and names the model that ran it — `task_notification`, the other channel
 * describing a delegate, reports a `total_tokens` roll-up with neither. Both
 * are needed to price one: the four kinds bill at rates 12.5x apart, so a total
 * cannot be priced, and a rate belongs to a model. Probed on 2.1.251:
 *
 * ```
 * {"type":"user","tool_use_result":{"status":"completed","agentId":"a8ff…",
 *  "agentType":"general-purpose","resolvedModel":"claude-opus-5[1m]",
 *  "totalDurationMs":1761,"totalTokens":29388,"totalToolUseCount":0,
 *  "usage":{"input_tokens":2,"cache_creation_input_tokens":29382,
 *           "cache_read_input_tokens":0,"output_tokens":4,…}},…}
 * ```
 *
 * `agentId` is the discriminator, and it has to be: this same root key carries
 * the rich result of OTHER tools, and a shell's or a search's would otherwise
 * be announced as a sub-agent. `costUsd` is left null here on purpose — the
 * breakdown is recorded against the launching call and priced on the `result`
 * line, which is the first line that says what any of it was charged at.
 */
function readClaudeDelegateResult(
  root: Record<string, unknown>,
  toolCallId: string,
  costLedger: ClaudeSessionCostLedger,
): AgentEvent | null {
  const result = asRecord(root.tool_use_result);
  const usage = result ? asRecord(result.usage) : null;
  if (!result || !usage || asString(result.agentId) === null || !toolCallId) {
    return null;
  }
  const model = asString(result.resolvedModel);
  const spend = {
    inputTokens: asNumber(usage.input_tokens),
    outputTokens: asNumber(usage.output_tokens),
    cacheReadTokens: asNumber(usage.cache_read_input_tokens),
    cacheCreationTokens: asNumber(usage.cache_creation_input_tokens),
  };
  costLedger.delegates.record(toolCallId, { model, ...spend });
  return {
    type: 'subagent_info',
    id: toolCallId,
    // Nulls where this line says nothing, on the merge rule every
    // `subagent_info` follows: the launching call already carried the brief and
    // the description, and a null cannot overwrite them.
    label: null,
    kind: asString(result.agentType),
    prompt: null,
    model,
    durationMs: asNumber(result.totalDurationMs),
    tokens: asNumber(result.totalTokens),
    toolUses: asNumber(result.totalToolUseCount),
    ...spend,
    costUsd: null,
    stepsUnavailableReason: null,
    // Deliberately silent on the lifecycle. `status` is right there and says
    // `completed`, but the delegate lifecycle has one owner already
    // (`announceDelegateWork`, off the task channels), and a second producer
    // answering the same question is how two channels come to disagree about
    // whether a delegate is still out.
    backgroundOutcome: null,
    backgroundOpen: null,
  };
}

/**
 * Every delegate this turn ran, priced — one `subagent_info` per delegate
 * carrying the dollars and nothing else.
 *
 * A separate announcement rather than a field on `turn_complete` because the
 * figure belongs to a DELEGATE, and the transcript already has a row per
 * delegate that merges by preferring the last non-null field. It rides the
 * `result` line because that is the first line stating what the CLI actually
 * charged, which is what the derivation is calibrated against.
 */
function mapDelegateCosts(
  root: Record<string, unknown>,
  costLedger: ClaudeSessionCostLedger,
): AgentEvent[] {
  return costLedger.delegates.settle(root).map(({ id, costUsd }) => ({
    type: 'subagent_info',
    id,
    label: null,
    kind: null,
    prompt: null,
    model: null,
    durationMs: null,
    tokens: null,
    toolUses: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    costUsd,
    stepsUnavailableReason: null,
    backgroundOutcome: null,
    backgroundOpen: null,
  }));
}

/**
 * A dynamic workflow's agent ROSTER, off a `system/task_progress` line.
 *
 * Undefined — never an empty array — when the line carries no
 * `workflow_progress` at all, and that difference is the whole discriminator:
 * a line WITH a roster is a workflow's, a line without it is a delegate's
 * progress (which names a `subagent_type` instead) or a workflow line the CLI
 * throttled the roster off. The consumer merges by preferring the last non-null
 * field, so "said nothing" must not arrive as "the roster is empty" — that
 * would empty a card every time a snapshot was throttled away.
 *
 * `workflow_phase` entries share the array and are dropped here. They carry a
 * phase's title, which every agent row already repeats as `phaseTitle`, so
 * keeping them would mean a second list to join against for a string already in
 * hand — and a phase with no agents yet is not something the card can draw.
 *
 * Key names are the CLI's own, read off the 2.1.251 capture recorded at
 * {@link CLAUDE_TASK_PROGRESS_SUBTYPE} rather than from any document.
 */
function readWorkflowAgents(
  root: Record<string, unknown>,
): WorkflowAgentSnapshot[] | undefined {
  const progress = root.workflow_progress;
  if (!Array.isArray(progress)) {
    return undefined;
  }
  const agents: WorkflowAgentSnapshot[] = [];
  for (const entry of asArray(progress)) {
    const row = asRecord(entry);
    if (row === null || asString(row.type) !== CLAUDE_WORKFLOW_AGENT_ENTRY) {
      continue;
    }
    const index = asNumber(row.index);
    if (index === null) {
      continue;
    }
    agents.push({
      index,
      label: asString(row.label),
      phase: asString(row.phaseTitle),
      // Unrecognised reads as `running`, per CLAUDE_WORKFLOW_AGENT_STATES: an
      // agent the roster still lists has not been said to have finished.
      state:
        CLAUDE_WORKFLOW_AGENT_STATES.get(asString(row.state) ?? '') ??
        'running',
      model: asString(row.model),
      tokens: asNumber(row.tokens),
      toolCalls: asNumber(row.toolCalls),
      durationMs: asNumber(row.durationMs),
      error: asString(row.error),
    });
  }
  return agents;
}

/**
 * The `mcp_servers` rows of a `system/init` line.
 *
 * `target`/`transport`/`detail` are null because init genuinely does not carry
 * them — it reports a name and a state and nothing else (verified live on
 * 2.1.222). Null is the honest answer here for the same reason it is on the
 * `mcp list` path: an empty string would assert a command line the CLI never
 * reported. `AgentMcpService` fills them from a previous listing when it has
 * one.
 */
function readInitMcpServers(root: Record<string, unknown>): AgentMcpServer[] {
  const servers: AgentMcpServer[] = [];
  for (const entry of asArray(root.mcp_servers)) {
    const row = asRecord(entry);
    const name = row ? asString(row.name) : null;
    if (!name) {
      continue;
    }
    const status = row ? asString(row.status) : null;
    servers.push({
      name,
      target: null,
      transport: null,
      status:
        (status === null ? undefined : INIT_STATUSES[status]) ?? 'unknown',
      detail: null,
    });
  }
  return servers;
}

/**
 * Map one parsed line of `claude -p --output-format stream-json` to normalized
 * events. Shapes verified against a live `claude` 2.1.196 capture:
 * - `system/init` carries the `session_id` (→ resume slot).
 * - `assistant.message.content[]` blocks: `text` / `thinking` / `tool_use`.
 * - `user.message.content[]` `tool_result` blocks close a tool call.
 * - `result` carries the final text, `usage`, `total_cost_usd`, `stop_reason`.
 * - `control_request` (`can_use_tool`) is the permission pause of the stdin
 *   control protocol (`--permission-prompt-tool stdio`, `ask` approval mode);
 *   verified against a live 2.1.199 capture.
 * - Anything else (`hook_*`, `post_turn_summary`, `rate_limit_event`, …) is
 *   ignored — the stream legitimately includes event types this turn doesn't model.
 *
 * An exported pure function rather than a method: `ClaudeAdapter.mapMessage` is
 * a one-line delegate, so every shape above is drivable from a spec without
 * spawning a process.
 */
export function mapClaudeMessage(
  obj: unknown,
  costLedger: ClaudeSessionCostLedger,
): AgentEvent[] {
  const root = asRecord(obj);
  if (!root) {
    return [];
  }
  // Stamped ONCE, around the whole switch, because the field describes the LINE
  // rather than any block on it — every event this line produces came from the
  // same thread. Doing it here also means an arm added later cannot forget it.
  //
  // An empty string is normalized to null, and that is not defensive noise:
  // `asString` passes `''` through, so without this a line carrying one would
  // suppress the context meter for the whole turn AND be persisted as a
  // sub-agent row — while the renderer half of this twin rejects `''` and calls
  // the same row the main thread's. Two readings of one shape must not disagree
  // about which thread wrote it.
  const parentToolUseId = asString(root.parent_tool_use_id) || null;
  return mapClaudeLine(root, parentToolUseId, costLedger).map((event) =>
    // `subagent_info` is the ONE exception, and it is the same rule
    // `utils/event-to-item.ts` states from the other side: that event is ABOUT
    // a delegate rather than produced BY one, so it carries the launching call
    // in its own `id` and must never carry an origin as well. It is emitted
    // from a delegate's own line below — the only line that names the model it
    // is running — so without this carve-out the stamp would file the
    // declaration as one of the delegate's own rows.
    parentToolUseId === null || event.type === 'subagent_info'
      ? event
      : { ...event, parentToolUseId },
  );
}

/**
 * The per-line mapping, with the sub-agent origin already read off the root.
 *
 * `parentToolUseId` is passed in rather than re-read because one arm needs to
 * BRANCH on it and not merely carry it: see the `assistant` case.
 */
function mapClaudeLine(
  root: Record<string, unknown>,
  parentToolUseId: string | null,
  costLedger: ClaudeSessionCostLedger,
): AgentEvent[] {
  switch (asString(root.type)) {
    case 'system': {
      if (asString(root.subtype) === 'thinking_tokens') {
        return mapClaudeThinkingTokens(root);
      }
      if (asString(root.subtype) === CLAUDE_COMPACT_BOUNDARY_SUBTYPE) {
        // Shape taken from the 2.1.226 binary's own schema:
        // `compact_metadata: { trigger: 'manual'|'auto', pre_tokens: int,
        // post_tokens?: int }`. Read defensively regardless — the metadata is
        // optional on the wire, and a boundary carrying no numbers is still
        // worth reporting, because the EVENT is what explains the meter.
        const meta = asRecord(root.compact_metadata);
        return [
          {
            type: 'context_compacted',
            phase: 'finished',
            trigger: meta ? asString(meta.trigger) : null,
            preTokens: meta ? asNumber(meta.pre_tokens) : null,
            postTokens: meta ? asNumber(meta.post_tokens) : null,
          },
        ];
      }
      if (asString(root.subtype) === CLAUDE_STATUS_SUBTYPE) {
        // Two lines share this subtype and they are told apart by `status`: a
        // named status opens the state, and a null one closes it while carrying
        // the verdict. See CLAUDE_STATUS_SUBTYPE for the captured pair.
        const status = asString(root.status);
        if (status === CLAUDE_COMPACTING_STATUS) {
          return [
            {
              type: 'context_compacted',
              phase: 'started',
              trigger: null,
              preTokens: null,
              postTokens: null,
            },
          ];
        }
        if (asString(root.compact_result) === CLAUDE_COMPACT_RESULT_FAILED) {
          // A compaction that did NOT happen is the one outcome that earns a
          // durable row. The success path needs none — its own boundary and the
          // summary line below both speak for it — but a silent failure leaves
          // the user at full context waiting on a compaction that never came.
          //
          // BOTH events, and the second is not optional: `started` announced a
          // present-tense "compacting the conversation", and only a terminal
          // phase takes that phrase back down. The success path is
          // self-correcting because it emits a boundary; this path emits none,
          // so without the `failed` event the row would keep claiming a
          // compaction was running after the CLI had declined it.
          const reason = asString(root.compact_error);
          return [
            {
              type: 'notice',
              message:
                reason === null
                  ? CLAUDE_COMPACT_FAILED_NOTICE
                  : `${CLAUDE_COMPACT_FAILED_NOTICE} — ${reason}`,
            },
            {
              type: 'context_compacted',
              phase: 'failed',
              trigger: null,
              preTokens: null,
              postTokens: null,
            },
          ];
        }
        // Any other status is a state this daemon does not model. Dropped, not
        // guessed at.
        return [];
      }
      if (asString(root.subtype) === CLAUDE_TASK_STARTED_SUBTYPE) {
        const id = asString(root.task_id);
        if (id === null) {
          return [];
        }
        const toolCallId = asString(root.tool_use_id);
        const events: AgentEvent[] = [
          {
            type: 'background_work',
            id,
            phase: 'started',
            // `local_agent` is this CLI's word for a delegate; a `local_bash`
            // on the same channel is the shell command one of them ran, and
            // `owned_by_subagent` marks work a delegate started rather than
            // work that IS one (probed 2026-08-17 on 2.1.232 — one turn
            // produced both, from one Task call).
            unit:
              asString(root.task_type) === CLAUDE_TASK_TYPE_AGENT &&
              root.owned_by_subagent !== true
                ? 'agent'
                : 'other',
            toolCallId,
          },
        ];
        // A workflow's ANCHOR, and the only line that ever states its name: the
        // progress lines after it carry `summary` (the description) and never
        // `workflow_name`, so a card built from those alone could say what the
        // workflow does and never what it IS. Emitted here rather than waiting
        // for the first roster so the card opens the moment the tool call does,
        // which for a workflow is minutes before its first agent settles.
        if (
          toolCallId !== null &&
          asString(root.task_type) === CLAUDE_TASK_TYPE_WORKFLOW
        ) {
          events.push({
            type: 'workflow_info',
            id: toolCallId,
            name: asString(root.workflow_name),
            title: asString(root.description),
            activity: null,
            tokens: null,
            toolUses: null,
            durationMs: null,
            agents: null,
          });
        }
        return events;
      }
      if (asString(root.subtype) === CLAUDE_TASK_PROGRESS_SUBTYPE) {
        // Workflow lines ONLY, and the roster is what tells them apart — a
        // delegate's progress rides this same subtype (see
        // CLAUDE_TASK_PROGRESS_SUBTYPE). Dropping the roster-less lines is also
        // what keeps this channel from writing a transcript row every few
        // milliseconds: the CLI emits progress per batch and attaches the roster
        // only when an agent changed state, which is the same moment the totals
        // move, so nothing is lost by ignoring the rest.
        const agents = readWorkflowAgents(root);
        const toolCallId = asString(root.tool_use_id);
        if (agents === undefined || toolCallId === null) {
          return [];
        }
        const usage = asRecord(root.usage);
        return [
          {
            type: 'workflow_info',
            id: toolCallId,
            // Never on a progress line — the anchor is where a name comes from.
            name: null,
            title: asString(root.summary),
            activity: asString(root.description),
            tokens: usage ? asNumber(usage.total_tokens) : null,
            toolUses: usage ? asNumber(usage.tool_uses) : null,
            durationMs: usage ? asNumber(usage.duration_ms) : null,
            agents,
          },
        ];
      }
      if (
        asString(root.subtype) === CLAUDE_TASK_UPDATED_SUBTYPE ||
        asString(root.subtype) === CLAUDE_TASK_NOTIFICATION_SUBTYPE
      ) {
        const id = asString(root.task_id);
        // The two channels carry the status in different places, so read both
        // and let a null fall through to "still open" — never to closed.
        const patch = asRecord(root.patch);
        const status =
          asString(root.status) ?? (patch ? asString(patch.status) : null);
        const outcome =
          status === null
            ? undefined
            : CLAUDE_TASK_TERMINAL_STATUSES.get(status);
        return id !== null && outcome !== undefined
          ? [
              {
                type: 'background_work',
                id,
                phase: 'settled',
                // A settle says nothing about WHAT settled — `task_updated`
                // carries only the id and a status patch — so the kind is not
                // guessed here. The consumer remembers it from the `started`,
                // which is the only line that states it.
                unit: 'other',
                toolCallId: asString(root.tool_use_id),
                // HOW it ended, translated out of this CLI's vocabulary here so
                // no consumer downstream has to know that `killed` and
                // `stopped` are the same outcome spelled by two channels.
                outcome,
                // What the unit spent. Only `task_notification` carries it —
                // `task_updated` is an id and a status patch — so the two
                // channels this daemon deliberately maps from both stay safe:
                // an `undefined` here claims nothing, and the notification's
                // figures are not lost if the updated line happens to arrive
                // second. Probed on 2.1.237 against a real delegation:
                // `{total_tokens: 26124, tool_uses: 0, duration_ms: 2029}`.
                usage: readClaudeTaskUsage(root),
              },
            ]
          : [];
      }
      {
        // The SAME normalized event `init` produces below, and deliberately so:
        // this line carries the identical set of names with each entry's own
        // sentence beside it, so a consumer that already folds `slash_commands`
        // gets the descriptions for free. It is the reload's answer rather than
        // a startup announcement — see `CLAUDE_RELOAD_COMMANDS_SUBTYPE` in
        // `claude.const.ts` for the request that asks for it and the three
        // measurements behind it.
        const announced = readCommandsChanged(root);
        if (announced !== null) {
          return announced.length > 0
            ? [{ type: 'slash_commands', commands: announced }]
            : [];
        }
      }
      if (asString(root.subtype) === 'init') {
        const events: AgentEvent[] = [];
        const sessionId = asString(root.session_id);
        if (sessionId) {
          events.push({ type: 'session', sessionId });
        }
        // init's `slash_commands` is the session's authoritative invokable
        // set (built-ins + plugins + skills + commands) — harvested for the
        // composer's `/` autocomplete. Verified live on 2.1.211.
        //
        // Names and NOTHING else: the field is an array of plain strings, so
        // every entry reports a null description and the sentence beside it in
        // the popup comes from this CLI's disk scan instead (`skillRoots`).
        const commands = asArray(root.slash_commands)
          .map((entry) => asString(entry))
          .filter((entry): entry is string => entry !== null && entry !== '')
          .map((name) => ({ name, description: null }));
        if (commands.length > 0) {
          events.push({ type: 'slash_commands', commands });
        }
        // init's `mcp_servers` names every server this session loaded and the
        // state each was in — harvested so the MCP panel need not re-dial them
        // from cold to answer. Verified live on 2.1.222.
        const servers = readInitMcpServers(root);
        if (servers.length > 0) {
          events.push({ type: 'mcp_servers', servers });
        }
        // The only line before `result` that names the model. `assistant`
        // lines carry the CANONICAL id (`claude-opus-5`), which is not the key
        // `result.modelUsage` is keyed by (`claude-opus-5[1m]`) — so init's is
        // the one that can match a remembered window. Verified on 2.1.220.
        const model = asString(root.model);
        if (model) {
          events.push({ type: 'turn_model', model });
        }
        return events;
      }
      return [];
    }

    case 'stream_event':
      return mapClaudeStreamEvent(root);

    case 'assistant': {
      const message = asRecord(root.message);
      if (!message) {
        return [];
      }
      // A FAILED REQUEST, not the agent speaking — see {@link isClaudeApiErrorLine}
      // for the shape and the four codes it arrives under.
      //
      // REPORTED as «Я вижу вот такие ошибки в чате», against a transcript where
      // `API Error: Connection closed mid-response.` sat in an ordinary
      // assistant bubble, indistinguishable from an answer. It is the CLI's own
      // sentence about its own transport, so it belongs in the daemon's chrome
      // rather than in the agent's.
      //
      // `warning`, not the red failure chrome, and never `origin: 'cli'`:
      //
      // - Not `origin: 'cli'`, which exists for text the AGENT authored — a
      //   compaction summary of a conversation that can hold file contents and
      //   web pages, and so must not be able to dress itself as an advisory.
      //   This line is written by the CLI about its own request, and the flag
      //   that marks it is one the model cannot set, so there is no
      //   impersonation to defend against and the row is a real advisory.
      // - `warning` because this is not the turn's ENDING. The commonest code
      //   is `server_error`, which this CLI retries: the turn carries on and
      //   completes, so red would be a lie about what happened. When it IS
      //   fatal (`rate_limit`, `authentication_failed`) the turn's own `result`
      //   line produces the red `error` event a few lines later — carrying the
      //   code and the request id `ClaudeTurnDriver` remembered off THIS line —
      //   so the failure is still reported once, in the place that ends the turn.
      //
      // Returned ALONE. The rest of this branch reads a real request's usage
      // and content blocks; a synthetic failure line has no window reading
      // worth publishing and no tool calls to lift.
      if (isClaudeApiErrorLine(root)) {
        const reported = asArray(message.content)
          .map((block) => asString(asRecord(block)?.text))
          .filter((text): text is string => text !== null && text !== '')
          .join('\n');
        return reported === ''
          ? []
          : [
              {
                type: 'notice',
                message: reported,
                severity: 'warning',
                // Named, because the level's default caption (`not applied`)
                // describes a setting the agent could not honour and says
                // nothing true about a request that failed.
                caption: 'api error',
              },
            ];
      }
      const events: AgentEvent[] = [];
      // Lifted BEFORE the content blocks so the meter moves as soon as the
      // request lands, rather than trailing the words it produced.
      //
      // MAIN THREAD ONLY. A sub-agent's assistant line carries the usage of its
      // OWN request — a fresh, nearly empty context — and the meter shows one
      // number for the conversation. Reporting both made it fall to a few
      // thousand tokens the moment a sub-agent spoke and snap back on the next
      // main-thread line, which is the jumping the user reported. Probe-verified
      // on 2.1.226: sub-agent `assistant` lines set `parent_tool_use_id` to the
      // id of the `Agent` tool call that started them, main-thread ones set it
      // null.
      const contextTokens =
        parentToolUseId === null ? readClaudeAssistantContext(message) : null;
      if (contextTokens !== null) {
        events.push({ type: 'context_progress', contextTokens });
      }
      // WHICH MODEL a delegate is running, from the first line it speaks on.
      //
      // Every other channel that names a delegate's model reports it when the
      // work is OVER — the launching call's `tool_use_result` carries
      // `resolvedModel`, and nothing before it says anything — so a delegate
      // was unattributed for exactly as long as it ran, which is when a column
      // of a dozen of them is being read. The user's objection is what settled
      // it: a sub-agent always runs on SOME model, and both vendors' own UIs
      // say which throughout.
      //
      // The source is the Messages-API envelope every assistant line carries,
      // and it needs no new channel: this is the same `parent_tool_use_id` the
      // context meter above branches on. Verified on disk against a real
      // delegate's own transcript (2026-09-02) — its first assistant row
      // carries `message.model: 'claude-opus-5'`, and it is written before any
      // content block.
      //
      // ONCE per delegate per model (`noteDelegateModel`): a delegate emits an
      // assistant line per response, so announcing on each would persist
      // dozens of identical declaration rows per delegate. The later
      // `resolvedModel` still wins under the merge rule — it names the VARIANT
      // (`claude-opus-5[1m]`), which this line does not.
      if (parentToolUseId !== null) {
        const model = asString(message.model);
        if (
          model !== null &&
          costLedger.noteDelegateModel(parentToolUseId, model)
        ) {
          events.push({
            type: 'subagent_info',
            id: parentToolUseId,
            // Nulls throughout: this announcement claims ONE fact, and the
            // consumer merges by preferring the last non-null per field — so it
            // must not blank the label, the brief or the figures other
            // announcements gave.
            label: null,
            kind: null,
            prompt: null,
            model,
            durationMs: null,
            tokens: null,
            toolUses: null,
            inputTokens: null,
            outputTokens: null,
            cacheReadTokens: null,
            cacheCreationTokens: null,
            costUsd: null,
            stepsUnavailableReason: null,
            backgroundOutcome: null,
            backgroundOpen: null,
          });
        }
      }
      for (const block of asArray(message.content)) {
        const b = asRecord(block);
        if (!b) {
          continue;
        }
        switch (asString(b.type)) {
          case 'text': {
            const text = asString(b.text);
            if (text) {
              events.push({ type: 'text', text });
            }
            break;
          }
          case 'thinking': {
            const text = asString(b.thinking) ?? asString(b.text);
            if (text) {
              events.push({ type: 'reasoning', text });
            }
            break;
          }
          case 'tool_use': {
            const toolCallId = asString(b.id) ?? '';
            const name = asString(b.name) ?? '';
            events.push({
              type: 'tool_call',
              id: toolCallId,
              name,
              input: b.input ?? null,
            });
            // The tool row is still written. The task announcement is an
            // ADDITION to it, not a replacement: the row is what every other
            // consumer (the tool group, the activity line, the debug log) is
            // built on, and only the transcript has any business hiding it —
            // which it does by matching this call's id, carried on the event.
            const task = claudeTaskEventFromToolUse(name, b.input, toolCallId);
            if (task !== null) {
              events.push(task);
            }
            break;
          }
          default:
            break;
        }
      }
      return events;
    }

    case 'user': {
      const message = asRecord(root.message);
      if (!message) {
        return [];
      }
      // A `user` line the USER did not write. After a compaction the CLI injects
      // its summary as one of these — `content` a plain STRING rather than the
      // block array every real user message carries, which is exactly why the
      // block loop below could never see it: `asArray` of a string is empty, so
      // the summary was skipped wholesale and never reached the transcript.
      //
      // Captured on 2.1.227 (see CLAUDE_STATUS_SUBTYPE for the full sequence):
      //   {"type":"user","message":{"role":"user","content":"This session is
      //    being continued…Summary:…"},"isReplay":false,"isSynthetic":true}
      //   {"type":"user","message":{"role":"user","content":"<local-command-stdout>
      //    Compacted </local-command-stdout>"},"isReplay":true}
      //
      // Both arrive in the same burst, and the two flags are what separate them:
      // the summary is synthetic and NOT a replay; the second is a replay of a
      // preserved line and carries no `isSynthetic`. Requiring synthetic keeps a
      // real user message out; requiring not-replay keeps the post-compaction
      // replay of the preserved segment from persisting the summary twice. The
      // TEXT is deliberately not pattern-matched — a CLI that rewords its
      // preamble would silently stop being surfaced again.
      const injectedText = asString(message.content);
      if (
        injectedText !== null &&
        injectedText.length > 0 &&
        asBoolean(root.isSynthetic) &&
        !asBoolean(root.isReplay)
      ) {
        // `origin: 'cli'` because the CLI wrote this, not the daemon. Without it
        // the renderer paints it in the failure chrome every other `notice`
        // earns, so a summary read as geniro reporting an error — and a summary
        // OF the conversation is untrusted content, which must not be able to
        // look like an application-level advisory.
        return [{ type: 'notice', message: injectedText, origin: 'cli' }];
      }
      const events: AgentEvent[] = [];
      const blocks = asArray(message.content);
      // A delegate's bill rides the LINE's root (`tool_use_result`) rather than
      // any block on it, and carries no call id of its own — so it can only be
      // attributed when the line closes exactly ONE call. Every delegate return
      // observed does, but a line that ever closed two would otherwise bill both
      // for the same work.
      const soleToolResult =
        blocks.filter(
          (entry) => asString(asRecord(entry)?.type) === 'tool_result',
        ).length === 1;
      for (const block of blocks) {
        const b = asRecord(block);
        if (!b || asString(b.type) !== 'tool_result') {
          continue;
        }
        const toolCallId = asString(b.tool_use_id) ?? '';
        events.push({
          type: 'tool_result',
          id: toolCallId,
          name: null,
          result: b.content ?? null,
          isError: asBoolean(b.is_error),
        });
        // What the delegate behind this call SPENT, broken down the way billing
        // breaks it down. The only line that states it, and it states it while
        // the turn is still working — the price comes later, on `result`.
        const delegate = soleToolResult
          ? readClaudeDelegateResult(root, toolCallId, costLedger)
          : null;
        if (delegate !== null) {
          events.push(delegate);
        }
        // Half of claude's task list is only readable HERE: a created task's id
        // is in its result, and `TaskList`'s result is the only statement of the
        // whole list. An error result is skipped — a failed call moved nothing,
        // and its text is the failure rather than the task.
        const task = asBoolean(b.is_error)
          ? null
          : claudeTaskEventFromToolResult(b.content, toolCallId);
        if (task !== null) {
          events.push(task);
        }
        if (isPermissionChannelFailure(b.content)) {
          // Say it OUT LOUD. This failure arrives as ordinary tool-result text
          // inside a collapsed tool row, so a run can accumulate dozens of them
          // with nothing on screen to say the permission channel died — 239 of
          // them sat unremarked in the author's own database, and finding them
          // took a SQL query. A notice lands it as a `system` item instead.
          events.push({
            type: 'notice',
            message: CLAUDE_PERMISSION_CHANNEL_FAILURE_NOTICE,
          });
        }
      }
      return events;
    }

    case 'control_request': {
      const request = asRecord(root.request);
      const id = asString(root.request_id);
      const subtype = request ? asString(request.subtype) : null;
      if (!request || !id || subtype !== 'can_use_tool') {
        // Not a bare drop: the subtype travels back as data so the caller can
        // log it. This mapper is pure by contract, so a subtype the adapter
        // does not model is invisible unless it leaves the function.
        return [{ type: 'unhandled_control', subtype: subtype ?? '<none>' }];
      }
      return [
        {
          type: 'approval_request',
          id,
          toolName: asString(request.tool_name) ?? '',
          input: request.input ?? null,
          // AskUserQuestion carries requires_user_interaction: true — the M4
          // question-vs-permission discriminator. Verified live on 2.1.202 and
          // re-probed on 2.1.220 (2026-07-29).
          requiresUserInteraction: asBoolean(request.requires_user_interaction)
            ? true
            : undefined,
        },
      ];
    }

    case 'result': {
      // Price this turn's delegates FIRST, and on every path out of this arm —
      // a failed turn still ran them, and a turn that "describes no work" still
      // billed for whatever it delegated. Settling only on the happy path would
      // leave those delegates in the pending map to be priced by the NEXT
      // turn's calibration, which is a different turn's model mix.
      const priced = mapDelegateCosts(root, costLedger);
      if (asBoolean(root.is_error)) {
        // The fallback carries the CLI's own `subtype` when the line has no
        // sentence of its own, because without it the user is handed three
        // words that answer nothing — reported verbatim as "i have error, i
        // dont know why". `error_during_execution` at least names the shape of
        // the failure and is searchable in the CLI's own vocabulary. A line
        // that DID carry text keeps only that text: `result` is claude's own
        // sentence about what went wrong, and a subtype appended to it would be
        // machine noise on the end of an explanation.
        // What KIND of failure, in the CLI's own vocabulary. `terminal_reason`
        // is the field that actually answers it (`api_error`); `subtype` is
        // NOT — probed on 2.1.234, a failed line carries `"is_error":true`
        // beside `"subtype":"success"`, so the fallback below used to append
        // the word `success` to a failure sentence.
        const code = asString(root.terminal_reason) ?? asString(root.subtype);
        const detail = errorDetail({
          code,
          httpStatus: asNumber(root.api_error_status),
          sessionId: asString(root.session_id),
          durationMs: asNumber(root.duration_ms),
        });
        // A turn the CLI ABORTED did not fail, and this CLI says so itself —
        // see {@link CLAUDE_ABORTED_TERMINAL_REASONS} for the two predicates
        // it carries and the `is_error: true` it ships anyway. Only the
        // FALLBACK changes: a line that came with its own sentence keeps it,
        // by the same rule as every other failure here.
        const aborted =
          code !== null && CLAUDE_ABORTED_TERMINAL_REASONS.has(code);
        return [
          ...priced,
          {
            type: 'error',
            message:
              asString(root.result) ??
              asString(root.error) ??
              (aborted
                ? CLAUDE_TURN_ABORTED_MESSAGE
                : code === null
                  ? CLAUDE_RUN_FAILED_MESSAGE
                  : `${CLAUDE_RUN_FAILED_MESSAGE} (${code})`),
            ...(detail ? { detail } : {}),
          },
        ];
      }
      const usage = readClaudeUsage(root, costLedger);
      const stopReason = asString(root.stop_reason);
      const finalText = asString(root.result) ?? null;
      if (describesNoWork(usage, stopReason, finalText)) {
        return priced;
      }
      return [
        ...priced,
        {
          type: 'turn_complete',
          usage,
          stopReason,
          finalText,
        },
      ];
    }

    default:
      return [];
  }
}

/**
 * Map one `stream_event` line to a live text increment, or [] to ignore it.
 *
 * With `CLAUDE_PARTIAL_MESSAGES_FLAG` (`claude.const.ts`) the CLI interleaves
 * `stream_event` lines with the ordinary ones; the completed `assistant`
 * message still arrives afterwards and remains the durable record. Only
 * `text_delta` is lifted:
 *
 * - `input_json_delta` streams a TOOL'S arguments — a large Write's whole file
 *   content would cross the wire twice for no benefit.
 * - `thinking_delta` carries `thinking: ""` — claude redacts reasoning text in
 *   headless mode (probe-verified: the block ships an encrypted `signature`
 *   and an empty body), so there is nothing to show. Reasoning-delta streaming
 *   is also explicitly out of scope for v1.
 * - `message_start` / `message_delta` / `message_stop` / `content_block_*` are
 *   framing the durable events already express.
 *
 * Verified live on claude-opus-5 alongside `--permission-prompt-tool stdio`:
 * deltas and the `can_use_tool` control dialogue coexist on one stream.
 */
export function mapClaudeStreamEvent(
  root: Record<string, unknown>,
): AgentEvent[] {
  const event = asRecord(root.event);
  if (!event || asString(event.type) !== 'content_block_delta') {
    return [];
  }
  const delta = asRecord(event.delta);
  if (!delta || asString(delta.type) !== 'text_delta') {
    return [];
  }
  const text = asString(delta.text);
  return text ? [{ type: 'text_delta', text }] : [];
}

/**
 * Map claude's `system/thinking_tokens` telemetry to a reasoning-progress
 * signal, or [] when the line carries no usable total.
 *
 * The CLI emits this several times per reasoning stretch (observed at 6.6s /
 * 7.6s / 10.9s / 11.3s of one turn) with a running `estimated_tokens` and a
 * per-event delta. It needs no argv flag. This is the ONLY thinking signal a
 * headless consumer gets — the text itself is redacted.
 */
export function mapClaudeThinkingTokens(
  root: Record<string, unknown>,
): AgentEvent[] {
  const tokens = asNumber(root.estimated_tokens);
  return tokens !== null && tokens > 0
    ? [{ type: 'thinking_progress', tokens }]
    : [];
}
