import type { ItemKind, RunStatus } from '../../runs/runs.types';
import type { AgentEvent } from '../adapters/adapter.types';

/**
 * Shared event→transcript mapping used by both the single-agent chat turn and
 * the graph-node executor, so a normalized `AgentEvent` becomes the same
 * persisted item shape regardless of which flow drove the adapter.
 */

/** One persisted transcript row, before it is given a `seq` and written. */
interface MappedItem {
  kind: ItemKind;
  role: string | null;
  payload: Record<string, unknown>;
}

/**
 * Map a normalized event to the persisted transcript item it becomes.
 *
 * TWIN PARSER: `apps/ui/src/renderer/chats/subagent-payload.ts` reads back the
 * `parentToolUseId` stamped here. An item payload is `z.unknown()` on the wire
 * BY DESIGN — every kind carries a different shape — so no generated type
 * crosses to the renderer and the two sides are independent readings of one
 * shape. Rename the key here and that file must change with it.
 */
export function mapEventToItem(event: AgentEvent): MappedItem | null {
  const item = mapEventBody(event);
  if (item === null || event.parentToolUseId == null) {
    return item;
  }
  // On the PAYLOAD rather than as a column: it means the same thing for every
  // kind, and a row with no sub-agent origin — the overwhelming majority —
  // carries nothing extra at all.
  return {
    ...item,
    payload: { ...item.payload, parentToolUseId: event.parentToolUseId },
  };
}

function mapEventBody(event: AgentEvent): MappedItem | null {
  switch (event.type) {
    case 'session':
      return null; // captured into node_state, not a transcript item
    case 'slash_commands':
      return null; // captured into the skill-harvest store, not a transcript item
    case 'mcp_servers':
      return null; // captured into the MCP-harvest store, not a transcript item
    case 'turn_model':
      return null; // seeds the live plane's window lookup, not a transcript item
    case 'unhandled_control':
      return null; // logged and dropped by AgentAdapter.start — a diagnostic, not a row
    case 'context_compacted':
      // Deliberately NOT a `system` row, at EITHER phase. Compaction is the
      // CLI's own housekeeping, and a permanent line saying it started and
      // another saying it finished, wedged between the user's messages, is noise
      // in the conversation they actually came for. It rides the ephemeral
      // activity channel instead, where it names the pause WHILE the pause is
      // happening and then goes away — which the finished phase now does by
      // announcing nothing at all, rather than leaving a past-tense sentence
      // standing in a spinning row (see `context_compacted` in
      // `chat.service.ts`).
      //
      // What DOES earn a durable row is the part with content: the CLI's own
      // summary of what it compacted, and a compaction that FAILED. Both arrive
      // as `notice` events from the mapper, so they land as `system` rows below
      // without this arm having to carry text it does not have.
      return null;
    case 'turn_held':
      // Live state, not history: the hold is over by the time anyone replays
      // this transcript, and a durable "waiting on 2 sub-agents" row
      // wedged between the agent's messages would be a permanent record of a
      // moment. It rides the activity channel instead — see `AgentEvent`.
      return null;
    case 'background_work':
      // Turn plumbing — `runCliSession` consumes it to decide when the turn is
      // really over and never forwards it, so this arm is unreachable in
      // practice. Answered anyway, and with null: the delegate's own rows are
      // what the transcript shows, and a pair of "background work started /
      // settled" rows beside them would say the same thing twice.
      return null;
    case 'thinking_progress':
    case 'context_progress':
    case 'text_delta':
    case 'reasoning_delta':
      // The EPHEMERAL live plane. This switch has no `default` on purpose:
      // adding an AgentEvent arm breaks the build until someone decides,
      // here, whether it becomes a durable row — which is what stops a
      // per-token delta from ever growing the database.
      return null;
    case 'text':
      return {
        kind: 'message',
        role: 'assistant',
        payload: { text: event.text },
      };
    case 'user_message':
      // The same row the chat service writes for a message typed into the
      // composer, deliberately — an imported conversation must be
      // indistinguishable from one held here, or scrolling back through a
      // resumed thread crosses a visible seam where the app changed its mind
      // about what a user message looks like.
      return {
        kind: 'message',
        role: 'user',
        payload: { text: event.text },
      };
    case 'reasoning':
      return {
        kind: 'reasoning',
        role: 'assistant',
        payload: { text: event.text },
      };
    case 'tool_call':
      return {
        kind: 'tool_call',
        role: 'assistant',
        // `toolKind` — NOT `kind`, which this row's own item kind already uses.
        // Two different `kind`s one object apart is how a reader ends up
        // bucketing tool calls by the string `'tool_call'`.
        //
        // TWIN PARSER: `apps/ui/src/renderer/chats/tool-kind.ts` reads it back to
        // say what the group DID. An item payload is `z.unknown()` on the wire BY
        // DESIGN — every kind carries a different shape — so no generated type
        // spans the two sides, and renaming the key here means renaming it there.
        //
        // Absent when the CLI does not classify its calls (claude), which is what
        // keeps every existing row byte-identical to what it was.
        payload: {
          id: event.id,
          name: event.name,
          input: event.input,
          ...(event.kind === undefined ? {} : { toolKind: event.kind }),
        },
      };
    case 'tool_result':
      return {
        kind: 'tool_result',
        role: 'tool',
        payload: {
          id: event.id,
          name: event.name,
          result: event.result,
          isError: event.isError,
        },
      };
    case 'subagent_info':
      // A row about a DELEGATE, not one the delegate produced — so `id` is the
      // launching tool call's id in the payload's own `id` key, exactly as
      // `tool_call`/`tool_result` carry theirs, and never
      // `AgentEventOrigin.parentToolUseId` (see the event's doc block).
      //
      // TWIN PARSER: `apps/ui/src/renderer/chats/subagent-payload.ts` reads
      // these keys back. An item payload is `z.unknown()` on the wire BY DESIGN
      // — every kind carries a different shape — so no generated type spans the
      // two sides. Renaming a key here means renaming it there.
      //
      // Nulls are written OUT rather than omitted: the consumer merges several
      // announcements per delegate by preferring the last non-null field, and an
      // omitted key and a null one must read the same for that to be safe.
      return {
        kind: 'subagent_info',
        role: null,
        payload: {
          id: event.id,
          label: event.label,
          kind: event.kind,
          prompt: event.prompt,
          model: event.model,
          durationMs: event.durationMs,
          tokens: event.tokens,
          toolUses: event.toolUses,
          stepsUnavailableReason: event.stepsUnavailableReason,
          backgroundOpen: event.backgroundOpen,
          backgroundOutcome: event.backgroundOutcome,
        },
      };
    case 'workflow_info':
      // A row ABOUT a dynamic workflow, on exactly the terms `subagent_info`
      // above sets: `id` is the LAUNCHING TOOL CALL's, never
      // `AgentEventOrigin.parentToolUseId`, because the main thread wrote this
      // about work the workflow is doing elsewhere.
      //
      // DURABLE, and for `task_list`'s reason rather than `shell_info`'s: the
      // workflow's agents never appear in the transcript at all, so the only
      // record that a tool call costing half a million tokens spawned thirty
      // agents is this row. A reopened chat replays items, so an ephemeral
      // signal would leave every past workflow as the opaque `Workflow` row
      // this exists to replace.
      //
      // TWIN PARSER: `apps/ui/src/renderer/chats/workflow-payload.ts` reads
      // these keys back and merges them. An item payload is `z.unknown()` on
      // the wire BY DESIGN — every kind carries a different shape — so no
      // generated type spans the two sides. Renaming a key here means renaming
      // it there.
      //
      // Nulls are written OUT rather than omitted, on the merge rule
      // `subagent_info` follows: the consumer prefers the last non-null field,
      // and an omitted key and a null one must read alike for that to be safe.
      return {
        kind: 'workflow_info',
        role: null,
        payload: {
          id: event.id,
          name: event.name,
          title: event.title,
          activity: event.activity,
          tokens: event.tokens,
          toolUses: event.toolUses,
          durationMs: event.durationMs,
          agents: event.agents,
        },
      };
    case 'shell_info':
      // A DURABLE row for the same reason `task_list` is one, and unlike the
      // `background_work` line it is derived from: it is the ONLY record that a
      // detached command has finished. The launching tool call returned the
      // moment the command was accepted, so nothing else in the transcript ever
      // closes it, and a client replaying this conversation would go on showing
      // it as running for as long as the chat exists.
      //
      // TWIN PARSER: `apps/ui/src/renderer/chats/shell-activity.ts` reads these
      // keys back to retire the shell they name. An item payload is
      // `z.unknown()` on the wire BY DESIGN — every kind carries a different
      // shape — so no generated type spans the two sides. Renaming a key here
      // means renaming it there.
      //
      // `id` is the LAUNCHING TOOL CALL, spelled the way `subagent_info` and
      // both halves of a tool call spell theirs, and written out even when null
      // so the reader's two match paths (by call, else by the CLI's own work
      // id) read an omitted key and a null one alike.
      return {
        kind: 'shell_info',
        role: null,
        payload: { id: event.toolCallId, workId: event.workId },
      };
    case 'shell_open':
      // A DURABLE row, symmetric with the close above, and it shipped as `null`
      // on the reasoning that "the start is already in the transcript as the
      // tool call that detached it". The CALL is; the DETACHMENT is not, and
      // that is the fact a reader needs.
      //
      // Which tool calls a CLI put in the background is read here off that
      // CLI's own structured frames (`background_work`, from `system/
      // task_started`). Without this row the renderer had to recover the same
      // fact from the CLI's ENGLISH — the `Command running in background with
      // ID: …` announcement written back to the launch — and that match is
      // deliberately strict, because a loose one promotes any foreground
      // command whose OUTPUT quotes the sentence into a shell nothing can ever
      // close (measured at 11 phantoms in 690 shells before it was tightened).
      // So it misses by design, and every miss put `Run.shellsOpen` — which
      // counts exactly these events — over a transcript naming fewer commands
      // than the count. REPORTED as a sidebar row reading `working · waiting on
      // background work` beside a header counting zero shells.
      //
      // The row is what makes those two views of ONE set. It does not double
      // anything: the reader marks the tool call it names, it never adds a
      // command of its own, and it is written once per unit by
      // `announceShellWork`.
      //
      // TWIN PARSER: `apps/ui/src/renderer/chats/shell-activity.ts` reads these
      // keys back to mark the launch they name as detached. An item payload is
      // `z.unknown()` on the wire BY DESIGN — every kind carries a different
      // shape — so no generated type spans the two sides. Renaming a key here
      // means renaming it there. `id` is the LAUNCHING TOOL CALL, spelled as
      // the close above spells it and written out even when null, so the
      // reader's two match paths read an omitted key and a null one alike.
      return {
        kind: 'shell_open',
        role: null,
        payload: { id: event.toolCallId, workId: event.workId },
      };
    case 'task_list':
      // A DURABLE row, unlike the other progress-shaped events above. The list
      // is not derivable from anything else in the transcript: a patch names
      // only what moved, so the current list is the fold of every announcement
      // from the first, and a client that replays from a cursor must see them
      // all. It is also what the user asked for — the agent's task list where
      // they can read it, instead of an opaque tool row saying a tool ran.
      //
      // TWIN PARSER: `apps/ui/src/renderer/chats/task-payload.ts` reads these
      // keys back and folds them. An item payload is `z.unknown()` on the wire
      // BY DESIGN — every kind carries a different shape — so no generated type
      // spans the two sides. Renaming a key here means renaming it there.
      //
      // `toolCallId` is written out even when null, on the same rule the
      // sub-agent row follows: the reader keys "which tool row does this list
      // replace" on it, and an omitted key and a null one must read alike.
      return {
        kind: 'task_list',
        role: null,
        payload: {
          mode: event.mode,
          tasks: event.tasks,
          toolCallId: event.toolCallId,
        },
      };
    case 'approval_request':
      return {
        kind: 'approval_request',
        role: null,
        payload: {
          id: event.id,
          toolName: event.toolName,
          input: event.input,
          // Persisted for transcript observability (correlates with the
          // daemon's flag-only drift warning); routing AND rendering both
          // key on the tool name, never on this flag.
          ...(event.requiresUserInteraction
            ? { requiresUserInteraction: true }
            : {}),
        },
      };
    case 'turn_complete':
      return {
        kind: 'turn_complete',
        role: null,
        payload: { usage: event.usage, stopReason: event.stopReason },
      };
    case 'notice':
      // Same shape the graph executor persists its own degrade messages in, so
      // an adapter-level degrade renders identically to an executor-level one.
      //
      // TWIN PARSER: `apps/ui/src/renderer/chats/system-payload.ts` reads the
      // `origin` key back to decide whether the row is the daemon speaking or
      // the CLI being relayed. An item payload is `z.unknown()` on the wire BY
      // DESIGN — every kind carries a different shape — so no generated type
      // spans the two sides. Rename the key here and that file must change too.
      return {
        kind: 'system',
        role: null,
        // Omitted entirely when the daemon wrote the message, so every existing
        // notice's row stays byte-identical to what it was.
        payload: {
          message: event.message,
          ...(event.origin ? { origin: event.origin } : {}),
          // Same rule as `origin`: stamped only when it is set, so every
          // existing notice's row stays byte-identical. Dropped entirely when
          // the CLI authored the text — a relayed message is not an advisory at
          // any volume, and letting it carry a severity would let it choose its
          // own chrome beside the daemon's real ones.
          ...(event.severity && !event.origin
            ? { severity: event.severity }
            : {}),
          // And `caption`, on the same two terms: stamped only when the
          // producer named one, dropped entirely for CLI-authored text.
          ...(event.caption && !event.origin ? { caption: event.caption } : {}),
        },
      };
    case 'turn_cancelled':
      return { kind: 'turn_cancelled', role: null, payload: {} };
    case 'error':
      return {
        kind: 'error',
        role: null,
        // `recovery` rides the payload only when the adapter recognised a cure,
        // so an ordinary failure's row stays byte-identical to what it was.
        //
        // TWIN PARSER: `apps/ui/src/renderer/chats/error-payload.ts` reads this
        // key back. An item payload is `z.unknown()` on the wire BY DESIGN —
        // every kind carries a different shape — so no generated type spans the
        // two sides. Renaming the key here means renaming it there.
        payload: {
          message: event.message,
          ...(event.recovery ? { recovery: event.recovery } : {}),
          // Likewise `detail` — the facts the failure reported about itself
          // (`AgentErrorDetail`), read back by the same twin parser. Absent
          // when the CLI said nothing beyond its sentence, so an error row from
          // a CLI that reports none of it is byte-identical to what it was.
          ...(event.detail ? { detail: event.detail } : {}),
        },
      };
  }
}

/**
 * Whether an OFF-TURN row means the run is working again.
 *
 * Asked at exactly one place — `ChatService.handleBetweenTurnEvent`, which only
 * ever sees events that produced a durable row — so the default is YES: a
 * settled run whose CLI is writing rows again is the CLI carrying on by itself,
 * and its own continuation settles it a second time. What this names is the
 * exceptions, which are the rows the DAEMON writes about the run's plumbing
 * rather than anything the agent produced.
 *
 * Named here, beside {@link offTurnActivity}, because it is the same kind of
 * question — what does this event say the run is DOING — and because a bare
 * `event.backgroundOpen === false` at the read site says nothing about why that
 * direction is treated differently.
 *
 * A DELEGATE announcement has two directions meaning opposite things
 * (`spawn-cli`'s `announceDelegateWork`): starting is work beginning, finishing
 * is work ending, and reading a finish as a start would latch the spinner on
 * with nothing left to take it down. `backgroundOpen` is nullable and null is
 * NOT a close — an announcement carrying the delegate's FACTS (its label, its
 * prompt) claims nothing about its liveness, and reading that as "it has
 * stopped" would silence a run every time the CLI described a delegate it had
 * just launched.
 *
 * BOTH SHELL ROWS are excluded, and that is the pair rather than one of them.
 * `shell_info` is a close and always was: a detached command routinely outlives
 * the turn that launched it, so without the exclusion every `pnpm dev`
 * finishing minutes after a chat settled would put that chat's badge back to
 * `running` forever. `shell_open` joined it when it became a row, and it is
 * excluded for a reason the delegate case makes look backwards — an OPEN really
 * is work beginning, but a backgrounded command deliberately does NOT hold a
 * turn (see `trackBackgroundWork`'s `unit === 'agent'` carve-out), so it is not
 * the AGENT working. The badge it earns is `held`, which the run row's own
 * `shellsOpen` already drives. Reading it as `running` would be the latch from
 * the other end: a shell emits no further row, so nothing until its close could
 * take the spinner down. Its own launching tool call is a main-thread row and
 * flips the badge on its own where that is genuinely true.
 */
export function restatesRunAsWorking(event: AgentEvent): boolean {
  return !(
    (event.type === 'subagent_info' && event.backgroundOpen === false) ||
    event.type === 'shell_info' ||
    event.type === 'shell_open'
  );
}

/** The run status a terminal event implies, or null for a mid-turn event. */
export function terminalStatus(event: AgentEvent): RunStatus | null {
  switch (event.type) {
    case 'turn_complete':
      return 'completed';
    case 'error':
      return 'failed';
    case 'turn_cancelled':
      return 'cancelled';
    default:
      return null;
  }
}

/**
 * The sentence under the badge for work the CLI did with no turn of ours open.
 *
 * It is deliberately marked as such rather than reusing the in-turn phrasing.
 * "running Bash" during a turn means the agent is doing what the user just
 * asked; the same words after the turn settled mean something else entirely —
 * the CLI carried on by itself, most often because a delegate reported back —
 * and a user watching a chat they thought was finished is owed that
 * distinction rather than a badge that silently starts again.
 *
 * Null for a terminal event: the badge itself is then the whole fact, and a
 * phrase under it would outlive the work it describes.
 */
export function offTurnActivity(event: AgentEvent): string | null {
  if (terminalStatus(event) !== null) {
    return null;
  }
  return event.type === 'tool_call' && event.name
    ? `still working · ${event.name}`
    : 'still working';
}
