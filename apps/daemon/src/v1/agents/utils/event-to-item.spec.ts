import { describe, expect, it } from 'vitest';

import type { AgentEvent } from '../adapters/adapter.types';
import {
  mapEventToItem,
  restatesRunAsWorking,
  terminalStatus,
} from './event-to-item';

// The one event→transcript projection BOTH execution paths (chat service and
// graph executor) persist through — each arm is pinned with a worked-example
// literal so a payload-field regression (e.g. isError dropped) fails here even
// though the adapter specs only cover CLI-line→AgentEvent.
describe('mapEventToItem', () => {
  it('drops session events — captured into node_state, never the transcript', () => {
    expect(mapEventToItem({ type: 'session', sessionId: 's1' })).toBeNull();
  });

  it('drops slash_commands reports — skill-harvest store, never the transcript', () => {
    expect(
      mapEventToItem({
        type: 'slash_commands',
        commands: [{ name: 'review', description: null }],
      }),
    ).toBeNull();
  });

  it('drops text deltas — the live plane must NEVER become a database row', () => {
    // A turn emits hundreds of these. The durable record is the `text` event
    // that follows; if this ever returned a row, every token would be written
    // and replayed.
    expect(mapEventToItem({ type: 'text_delta', text: 'The sea' })).toBeNull();
  });

  it('drops thinking progress — a turn reports it repeatedly', () => {
    expect(
      mapEventToItem({ type: 'thinking_progress', tokens: 300 }),
    ).toBeNull();
  });

  it('drops a compaction boundary — housekeeping, not a line in the conversation', () => {
    // Asserted because the default is the opposite: `notice` DOES become a
    // `system` row, so mapping compaction that way is the obvious mistake, and
    // it would wedge a permanent "compacted" line between the user's messages.
    // The event is announced as momentary activity instead.
    expect(
      mapEventToItem({
        type: 'context_compacted',
        phase: 'finished',
        trigger: 'auto',
        preTokens: 180_000,
        postTokens: 32_000,
      }),
    ).toBeNull();
  });

  it('drops the START of a compaction too — both ends are momentary', () => {
    // The `started` phase is newer than the arm's original decision, so it needs
    // its own assertion: an in-progress marker is even less of a transcript line
    // than the finished one, and it must not become a row that then sits there
    // claiming a compaction is still running.
    expect(
      mapEventToItem({
        type: 'context_compacted',
        phase: 'started',
        trigger: null,
        preTokens: null,
        postTokens: null,
      }),
    ).toBeNull();
  });

  it('maps text to an assistant message row', () => {
    expect(mapEventToItem({ type: 'text', text: 'hello there' })).toEqual({
      kind: 'message',
      role: 'assistant',
      payload: { text: 'hello there' },
    });
  });

  it('maps reasoning to an assistant reasoning row', () => {
    expect(mapEventToItem({ type: 'reasoning', text: 'let me think' })).toEqual(
      {
        kind: 'reasoning',
        role: 'assistant',
        payload: { text: 'let me think' },
      },
    );
  });

  it('maps tool_call keeping id, name, and input intact', () => {
    expect(
      mapEventToItem({
        type: 'tool_call',
        id: 't1',
        name: 'Read',
        input: { path: '/x' },
      }),
    ).toEqual({
      kind: 'tool_call',
      role: 'assistant',
      payload: { id: 't1', name: 'Read', input: { path: '/x' } },
    });
  });

  it("stamps an agent's own classification as `toolKind`, and omits it otherwise", () => {
    // `toolKind`, not `kind`: the row's own item kind already owns that word one
    // object away, and a reader bucketing tool calls by the string 'tool_call' is
    // the mistake the rename prevents. Omitted for a CLI that classifies nothing,
    // which keeps every claude row byte-identical.
    expect(
      mapEventToItem({
        type: 'tool_call',
        id: 't1',
        name: 'Edit File',
        input: null,
        kind: 'edit',
      }),
    ).toEqual({
      kind: 'tool_call',
      role: 'assistant',
      payload: { id: 't1', name: 'Edit File', input: null, toolKind: 'edit' },
    });
    expect(
      mapEventToItem({ type: 'tool_call', id: 't2', name: 'Read', input: null })
        ?.payload,
    ).not.toHaveProperty('toolKind');
  });

  it('maps tool_result keeping id, name, result, and isError intact', () => {
    expect(
      mapEventToItem({
        type: 'tool_result',
        id: 't1',
        name: null,
        result: 'file body',
        isError: true,
      }),
    ).toEqual({
      kind: 'tool_result',
      role: 'tool',
      payload: { id: 't1', name: null, result: 'file body', isError: true },
    });
  });

  it('maps approval_request with no flag key when requiresUserInteraction is unset', () => {
    const mapped = mapEventToItem({
      type: 'approval_request',
      id: 'req-1',
      toolName: 'Write',
      input: { file_path: 'a.txt' },
    });
    expect(mapped).toEqual({
      kind: 'approval_request',
      role: null,
      payload: {
        id: 'req-1',
        toolName: 'Write',
        input: { file_path: 'a.txt' },
      },
    });
    // A plain permission must not fake the question discriminator — the key is
    // absent, not merely undefined.
    expect(
      'requiresUserInteraction' in (mapped!.payload as Record<string, unknown>),
    ).toBe(false);
  });

  it('maps a flagged approval_request carrying requiresUserInteraction: true', () => {
    expect(
      mapEventToItem({
        type: 'approval_request',
        id: 'req-q',
        toolName: 'AskUserQuestion',
        input: { questions: [] },
        requiresUserInteraction: true,
      }),
    ).toEqual({
      kind: 'approval_request',
      role: null,
      payload: {
        id: 'req-q',
        toolName: 'AskUserQuestion',
        input: { questions: [] },
        requiresUserInteraction: true,
      },
    });
  });

  it('maps turn_complete keeping usage and stopReason; finalText is not persisted', () => {
    expect(
      mapEventToItem({
        type: 'turn_complete',
        usage: {
          inputTokens: 12,
          outputTokens: 3,
          cacheReadTokens: null,
          cacheCreationTokens: null,
          thinkingTokens: null,
          contextTokens: 1012,
          contextWindowTokens: 1_000_000,
          contextModel: 'claude-sonnet-4-5',
          costUsd: 0.14,
          durationMs: 7618,
          apiMs: 7176,
        },
        stopReason: 'end_turn',
        finalText: 'pong',
      }),
    ).toEqual({
      kind: 'turn_complete',
      role: null,
      payload: {
        // The CLI's own turn timing reaches the persisted row untouched, which
        // is what lets a REOPENED chat say how long each turn worked. Pinned in
        // the whole-payload assertion rather than separately: this row is the
        // only place the figure is ever durable, so a mapper that dropped it
        // would leave the number visible live and gone on reload.
        usage: {
          inputTokens: 12,
          outputTokens: 3,
          cacheReadTokens: null,
          cacheCreationTokens: null,
          thinkingTokens: null,
          contextTokens: 1012,
          contextWindowTokens: 1_000_000,
          contextModel: 'claude-sonnet-4-5',
          costUsd: 0.14,
          durationMs: 7618,
          apiMs: 7176,
        },
        stopReason: 'end_turn',
      },
    });
  });

  it('maps turn_cancelled to an empty payload', () => {
    expect(mapEventToItem({ type: 'turn_cancelled' })).toEqual({
      kind: 'turn_cancelled',
      role: null,
      payload: {},
    });
  });

  it('maps error keeping the message', () => {
    expect(mapEventToItem({ type: 'error', message: 'boom' })).toEqual({
      kind: 'error',
      role: null,
      payload: { message: 'boom' },
    });
  });

  it('maps an adapter notice to a system item, like an executor-level degrade', () => {
    expect(
      mapEventToItem({ type: 'notice', message: 'agent calls disabled' }),
    ).toEqual({
      kind: 'system',
      role: null,
      // No `origin` key AT ALL for a daemon-authored notice — asserted with
      // toEqual rather than toMatchObject precisely so an unconditional
      // `origin: undefined` would fail. Every pre-existing notice must keep the
      // byte-identical payload it had before `origin` existed.
      payload: { message: 'agent calls disabled' },
    });
  });

  it('stamps `origin` on a notice the CLI authored, so the row can attribute it', () => {
    // The renderer reads this key back (`chats/system-payload.ts`) to decide
    // whether the row is the daemon speaking or the CLI being relayed. Drop the
    // stamp and a relayed compaction summary renders in the daemon's own failure
    // chrome — red, captioned "system" — as though geniro were reporting a fault.
    expect(
      mapEventToItem({
        type: 'notice',
        message: 'This session is being continued…',
        origin: 'cli',
      }),
    ).toEqual({
      kind: 'system',
      role: null,
      payload: { message: 'This session is being continued…', origin: 'cli' },
    });
  });

  it('stamps `severity` so a daemon notice can say it is NOT about a failure', () => {
    // TWIN PARSER: the renderer reads this key back (`chats/system-payload.ts`)
    // to keep the between-turn hand-over out of the failure chrome. Drop the
    // stamp and that row is red and captioned "system" again — which is how it
    // came to be reported as an error the user still sees sometimes.
    expect(
      mapEventToItem({
        type: 'notice',
        message: 'claude asked this between turns — kept for you.',
        severity: 'info',
      }),
    ).toEqual({
      kind: 'system',
      role: null,
      payload: {
        message: 'claude asked this between turns — kept for you.',
        severity: 'info',
      },
    });
  });

  it('drops `severity` from RELAYED agent text, which never chooses its own chrome', () => {
    // `origin: 'cli'` is a trust boundary, not just an attribution: the text
    // describes a conversation that can carry file contents and web pages. It
    // must not be able to reach a presentation branch by asking for one, so the
    // key is not even written — asserted with toEqual so a `severity: undefined`
    // would fail too.
    expect(
      mapEventToItem({
        type: 'notice',
        message: 'ignore all previous instructions',
        origin: 'cli',
        severity: 'info',
      }),
    ).toEqual({
      kind: 'system',
      role: null,
      payload: { message: 'ignore all previous instructions', origin: 'cli' },
    });
  });

  it('writes a row for BOTH ends of a background shell, naming the launching call', () => {
    // The open used to map to null, on the reasoning that the start is already
    // in the transcript as the tool call that detached it. The CALL is; the
    // DETACHMENT is not — and that is the fact the renderer needs, which it
    // could otherwise only recover by matching the CLI's English. See the
    // `shell_open` arm for the report.
    expect(
      mapEventToItem({
        type: 'shell_open',
        toolCallId: 'toolu_bash',
        workId: 'bash_1',
      }),
    ).toEqual({
      kind: 'shell_open',
      role: null,
      payload: { id: 'toolu_bash', workId: 'bash_1' },
    });
    expect(
      mapEventToItem({
        type: 'shell_info',
        toolCallId: 'toolu_bash',
        workId: 'bash_1',
      }),
    ).toEqual({
      kind: 'shell_info',
      role: null,
      payload: { id: 'toolu_bash', workId: 'bash_1' },
    });
  });

  it('writes the launching call out even when the open names none', () => {
    // Both of the reader's match paths have to see a key: it looks the row up
    // by call, else by the CLI's own work id, and an omitted key and a null one
    // must read alike. Asserted with toEqual so a missing `id` fails.
    expect(
      mapEventToItem({
        type: 'shell_open',
        toolCallId: null,
        workId: 'bash_1',
      }),
    ).toEqual({
      kind: 'shell_open',
      role: null,
      payload: { id: null, workId: 'bash_1' },
    });
  });
});

describe('mapEventToItem — sub-agent origin', () => {
  const SUB = 'toolu_01GffB3XLs9hgFTpZLrsex4f';

  it('stamps the origin onto the payload the renderer reads', () => {
    // TWIN PARSER: `apps/ui/src/renderer/chats/subagent-payload.ts` reads this
    // exact key off the payload. The payload is `z.unknown()` on the wire, so
    // no generated type ties the two sides together — this literal is the
    // contract, and renaming the key here without renaming it there silently
    // returns the transcript to one interleaved flat run.
    expect(
      mapEventToItem({
        type: 'tool_call',
        id: 't1',
        name: 'Bash',
        input: { command: 'echo hi' },
        parentToolUseId: SUB,
      }),
    ).toEqual({
      kind: 'tool_call',
      role: 'assistant',
      payload: {
        id: 't1',
        name: 'Bash',
        input: { command: 'echo hi' },
        parentToolUseId: SUB,
      },
    });
  });

  it('adds NO key at all for main-thread work', () => {
    // The common case by a wide margin, and every row of it is a database
    // write: an always-present `parentToolUseId: null` would cost a field on
    // every row to say nothing.
    const item = mapEventToItem({
      type: 'tool_call',
      id: 't1',
      name: 'Bash',
      input: null,
    });
    expect(item?.payload).not.toHaveProperty('parentToolUseId');
  });

  it('does not resurrect an ephemeral event just because it has an origin', () => {
    // The ephemeral plane is never a database row, origin or not.
    expect(
      mapEventToItem({
        type: 'context_progress',
        contextTokens: 10,
        parentToolUseId: SUB,
      }),
    ).toBeNull();
  });
});

describe('mapEventToItem — the sub-agent declaration', () => {
  it('writes the keys the renderer reads back, nulls included', () => {
    // TWIN PARSER: `apps/ui/src/renderer/chats/subagent-payload.ts` reads these
    // exact keys. Nulls are written OUT rather than omitted on purpose: a CLI
    // announces one delegate twice (an anchor, then its brief) and the consumer
    // merges by preferring the last non-null field — which only holds if an
    // omitted key and a null one read the same.
    expect(
      mapEventToItem({
        type: 'subagent_info',
        id: 'toolu_018bc',
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
        costUsd: null,
        stepsUnavailableReason: 'cursor-agent reports the delegation only',
        backgroundOpen: null,
        backgroundOutcome: null,
      }),
    ).toEqual({
      kind: 'subagent_info',
      role: null,
      payload: {
        id: 'toolu_018bc',
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
        costUsd: null,
        stepsUnavailableReason: 'cursor-agent reports the delegation only',
        backgroundOpen: null,
        backgroundOutcome: null,
      },
    });
  });

  it('persists a workflow row whole — the only record its fleet ever ran', () => {
    // A workflow's agents emit nothing onto this stream: they run inside the
    // CLI's own orchestrator with transcripts of their own. So unlike every
    // other row here, this one is not a second telling of something already in
    // the transcript — drop a field and the fact is simply gone.
    expect(
      mapEventToItem({
        type: 'workflow_info',
        id: 'toolu_01F7',
        name: 'probe-run',
        title: 'Two trivial agents',
        activity: 'Probe: probe-2',
        tokens: 27559,
        toolUses: 4,
        durationMs: 2432,
        agents: [
          {
            index: 1,
            label: 'probe-1',
            phase: 'Probe',
            state: 'done',
            model: 'claude-haiku-4-5-20251001',
            tokens: 13779,
            toolCalls: 2,
            durationMs: 1303,
            error: null,
          },
        ],
      }),
    ).toEqual({
      kind: 'workflow_info',
      role: null,
      payload: {
        id: 'toolu_01F7',
        name: 'probe-run',
        title: 'Two trivial agents',
        activity: 'Probe: probe-2',
        tokens: 27559,
        toolUses: 4,
        durationMs: 2432,
        agents: [
          {
            index: 1,
            label: 'probe-1',
            phase: 'Probe',
            state: 'done',
            model: 'claude-haiku-4-5-20251001',
            tokens: 13779,
            toolCalls: 2,
            durationMs: 1303,
            error: null,
          },
        ],
      },
    });
  });

  it('anchors on the payload’s own `id`, never on a sub-agent ORIGIN', () => {
    // The distinction the whole feature rests on: this row is one the MAIN
    // thread produced ABOUT a delegate, not one the delegate produced. Stamped
    // as `parentToolUseId` it would be folded INTO the delegate's own thread as
    // an invisible entry, and "has this delegate done anything?" — the question
    // the empty-thread notice answers — would read as yes.
    const item = mapEventToItem({
      type: 'subagent_info',
      id: 'toolu_018bc',
      label: 'Review the diff',
      kind: 'explore',
      prompt: 'look at everything',
      model: 'claude-opus-5',
      durationMs: 13075,
      tokens: null,
      toolUses: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      costUsd: null,
      stepsUnavailableReason: null,
      backgroundOpen: null,
      backgroundOutcome: null,
    });
    expect(item?.payload).not.toHaveProperty('parentToolUseId');
    expect(item?.payload.id).toBe('toolu_018bc');
  });
});

describe('terminalStatus', () => {
  it('maps each terminal event to its run status', () => {
    expect(
      terminalStatus({
        type: 'turn_complete',
        usage: null,
        stopReason: null,
        finalText: null,
      }),
    ).toBe('completed');
    expect(terminalStatus({ type: 'error', message: 'boom' })).toBe('failed');
    expect(terminalStatus({ type: 'turn_cancelled' })).toBe('cancelled');
  });

  it('returns null for every mid-turn event', () => {
    const midTurn: AgentEvent[] = [
      { type: 'text', text: 'hi' },
      { type: 'reasoning', text: 'hm' },
      { type: 'tool_call', id: 't1', name: 'Read', input: null },
      { type: 'notice', message: 'a degrade, not the end of the turn' },
      {
        type: 'tool_result',
        id: 't1',
        name: null,
        result: null,
        isError: false,
      },
      { type: 'session', sessionId: 's1' },
      {
        type: 'slash_commands',
        commands: [{ name: 'review', description: null }],
      },
      { type: 'approval_request', id: 'req-1', toolName: 'Write', input: null },
    ];
    for (const event of midTurn) {
      expect(terminalStatus(event)).toBeNull();
    }
  });
});

describe('restatesRunAsWorking', () => {
  /** The announcement `spawn-cli` makes about one delegate's liveness. */
  const announce = (backgroundOpen: boolean | null): AgentEvent => ({
    type: 'subagent_info',
    id: 'toolu_a',
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
    costUsd: null,
    stepsUnavailableReason: null,
    backgroundOpen,
    backgroundOutcome: null,
  });

  it('is false only for the announcement that a delegate has STOPPED', () => {
    expect(restatesRunAsWorking(announce(false))).toBe(false);
    expect(restatesRunAsWorking(announce(true))).toBe(true);
  });

  it('reads an announcement that claims nothing about liveness as no close', () => {
    // A `subagent_info` carrying a delegate's FACTS says nothing about whether
    // it is running; reading null as a close would silence the run every time
    // the CLI described the delegate it had just launched.
    expect(restatesRunAsWorking(announce(null))).toBe(true);
  });

  it('is false for BOTH ends of a background shell', () => {
    // The close, unconditionally: without it a `pnpm dev` finishing minutes
    // after a chat settled puts that chat's badge back to `running` with
    // nothing able to take it down.
    expect(
      restatesRunAsWorking({
        type: 'shell_info',
        toolCallId: 'toolu_a',
        workId: 'b_1',
      }),
    ).toBe(false);
    // And the OPEN, which became a row and would otherwise latch the spinner
    // from the other end: a detached command deliberately does not hold a turn,
    // so it is not the AGENT working, and it emits no further row until its
    // close — so nothing in between could take the spinner down.
    expect(
      restatesRunAsWorking({
        type: 'shell_open',
        toolCallId: 'toolu_a',
        workId: 'b_1',
      }),
    ).toBe(false);
  });

  it('is true for every other event', () => {
    expect(restatesRunAsWorking({ type: 'text', text: 'hi' })).toBe(true);
    expect(
      restatesRunAsWorking({
        type: 'background_work',
        id: 'task-1',
        phase: 'settled',
        unit: 'agent',
        toolCallId: 'toolu_a',
      }),
    ).toBe(true);
  });
});
