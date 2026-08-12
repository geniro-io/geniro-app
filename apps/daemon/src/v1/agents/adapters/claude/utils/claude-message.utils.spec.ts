import { describe, expect, it } from 'vitest';

import {
  mapClaudeMessage,
  mapClaudeStreamEvent,
  mapClaudeThinkingTokens,
} from './claude-message.utils';

/** A stream_event line as captured from a live claude-opus-5 turn. */
const textDelta = (text: string): Record<string, unknown> => ({
  type: 'stream_event',
  event: {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text },
  },
});

/** A plain permission pause of the stdin control dialogue. */
const CONTROL_REQUEST =
  '{"type":"control_request","request_id":"req-1","request":{"subtype":"can_use_tool","tool_name":"Write","input":{"file_path":"a.txt"}}}\n';

describe('mapClaudeMessage', () => {
  it('extracts the session id from system/init', () => {
    expect(
      mapClaudeMessage({
        type: 'system',
        subtype: 'init',
        session_id: 'sess-1',
      }),
    ).toEqual([{ type: 'session', sessionId: 'sess-1' }]);
  });

  it('harvests init slash_commands alongside the session id, dropping non-strings', () => {
    expect(
      mapClaudeMessage({
        type: 'system',
        subtype: 'init',
        session_id: 'sess-1',
        slash_commands: ['review', 42, '', 'compact'],
      }),
    ).toEqual([
      { type: 'session', sessionId: 'sess-1' },
      { type: 'slash_commands', commands: ['review', 'compact'] },
    ]);
  });

  it('harvests init mcp_servers with the state each was in', () => {
    // Captured verbatim from a live 2.1.222 turn. This is the whole point of
    // the MCP harvest: the panel's alternative is `claude mcp list`, which
    // HEALTH-CHECKS — it dials, and therefore starts, every configured server
    // from cold (6.7s measured against nine of them). A wrong field name here
    // ships green and silently leaves the panel on that cold path.
    expect(
      mapClaudeMessage({
        type: 'system',
        subtype: 'init',
        session_id: 'sess-1',
        mcp_servers: [
          { name: 'codegraph', status: 'connected' },
          { name: 'ticktick', status: 'pending' },
          { name: 'claude.ai n8n', status: 'failed' },
        ],
      }),
    ).toEqual([
      { type: 'session', sessionId: 'sess-1' },
      {
        type: 'mcp_servers',
        servers: [
          {
            name: 'codegraph',
            // Init reports a name and a state and nothing else — the command
            // line is genuinely unknown here, and null is what says so.
            target: null,
            transport: null,
            status: 'connected',
            detail: null,
          },
          {
            name: 'ticktick',
            target: null,
            transport: null,
            status: 'pending',
            detail: null,
          },
          {
            name: 'claude.ai n8n',
            target: null,
            transport: null,
            status: 'failed',
            detail: null,
          },
        ],
      },
    ]);
  });

  it('carries a switched-off server through as disabled, not as unknown', () => {
    // PROBE-VERIFIED on 2.1.223, isolated CLAUDE_CONFIG_DIR, one local-scope
    // server: without `disabledMcpServers` init says `failed`, with it init
    // says `disabled`. The mapper used to omit that status from its allow-list
    // — on the stated reasoning that a switched-off server is never loaded and
    // so never reported, which is not what the CLI does — and every such row
    // was harvested as `unknown` instead.
    //
    // Where the CLI's own config could still be read the overlay put it right,
    // which is what kept this invisible. Where it could not, the panel fell
    // back to `status === 'disabled'` and rendered a switched-off server as on.
    const [event] = mapClaudeMessage({
      type: 'system',
      subtype: 'init',
      mcp_servers: [{ name: 'probe-server', status: 'disabled' }],
    });

    expect(event).toEqual({
      type: 'mcp_servers',
      servers: [
        expect.objectContaining({ name: 'probe-server', status: 'disabled' }),
      ],
    });
  });

  it('keeps a server whose status it cannot read, calling it unknown', () => {
    // The server is real either way. Dropping it would shrink the listing on a
    // CLI wording change; calling it `failed` would invent a problem. A row
    // with no usable name is the one thing genuinely not listable.
    const [event] = mapClaudeMessage({
      type: 'system',
      subtype: 'init',
      mcp_servers: [
        { name: 'reworded', status: 'needs-auth' },
        { name: 'no-status' },
        { status: 'connected' },
        'not-an-object',
      ],
    });

    expect(event).toEqual({
      type: 'mcp_servers',
      servers: [
        expect.objectContaining({ name: 'reworded', status: 'unknown' }),
        expect.objectContaining({ name: 'no-status', status: 'unknown' }),
      ],
    });
  });

  it('reports the model init names, so a window can be applied before turn end', () => {
    // The whole per-model window feature hangs off this one field. `assistant`
    // lines carry the CANONICAL id (`claude-opus-5`), which is not the key
    // `result.modelUsage` uses (`claude-opus-5[1m]`) and so cannot match a
    // remembered window — init's is the one that can. A wrong field name here
    // ships green and leaves the feature inert.
    expect(
      mapClaudeMessage({
        type: 'system',
        subtype: 'init',
        session_id: 'sess-1',
        model: 'claude-opus-5[1m]',
      }),
    ).toEqual([
      { type: 'session', sessionId: 'sess-1' },
      { type: 'turn_model', model: 'claude-opus-5[1m]' },
    ]);
  });

  it('says nothing about the model when init names none', () => {
    expect(
      mapClaudeMessage({ type: 'system', subtype: 'init', model: 42 }),
    ).toEqual([]);
  });

  it('ignores non-init system events (hook_*, post_turn_summary)', () => {
    expect(
      mapClaudeMessage({ type: 'system', subtype: 'hook_started' }),
    ).toEqual([]);
    expect(
      mapClaudeMessage({ type: 'system', subtype: 'post_turn_summary' }),
    ).toEqual([]);
  });

  it('maps assistant text/thinking/tool_use blocks in order', () => {
    const events = mapClaudeMessage({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'let me think' },
          { type: 'text', text: 'hello' },
          { type: 'tool_use', id: 't1', name: 'Read', input: { path: '/x' } },
        ],
      },
    });
    expect(events).toEqual([
      { type: 'reasoning', text: 'let me think' },
      { type: 'text', text: 'hello' },
      { type: 'tool_call', id: 't1', name: 'Read', input: { path: '/x' } },
    ]);
  });

  it('maps a user tool_result block', () => {
    expect(
      mapClaudeMessage({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 't1',
              content: 'file body',
              is_error: false,
            },
          ],
        },
      }),
    ).toEqual([
      {
        type: 'tool_result',
        id: 't1',
        name: null,
        result: 'file body',
        isError: false,
      },
    ]);
  });

  /**
   * The permission channel dying under the CLI. It arrives as ordinary tool
   * RESULT TEXT, which is why nothing reacted to it and why 239 occurrences sat
   * unremarked in one database until a SQL query went looking.
   */
  const permissionFailure = (content: unknown): unknown =>
    mapClaudeMessage({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't9', content, is_error: true },
        ],
      },
    });

  it('raises a notice when a tool result is the permission channel failing', () => {
    const events = permissionFailure(
      'Tool permission request failed: AbortError: Stream closed',
    );

    // The raw result still reaches the transcript untouched — the notice is an
    // ADDITION, so nothing the agent saw is rewritten.
    expect(events).toEqual([
      expect.objectContaining({ type: 'tool_result', id: 't9', isError: true }),
      expect.objectContaining({ type: 'notice' }),
    ]);
  });

  it('matches the CLI wording whose middle varies, and finds it inside block content', () => {
    // `Error: Stream closed` appears beside `AbortError: Stream closed` in the
    // CLI's own issue tracker, so only the two stable halves are matched — and
    // `content` is an array of blocks on some results, a bare string on others.
    expect(
      permissionFailure([
        { type: 'text', text: 'Tool permission request failed: Stream closed' },
      ]),
    ).toEqual([
      expect.objectContaining({ type: 'tool_result' }),
      expect.objectContaining({ type: 'notice' }),
    ]);
  });

  it('does NOT fire on a tool that merely mentions one half', () => {
    // A grep hit or a test name containing "Stream closed" is not the channel
    // dying; requiring BOTH markers is what keeps this from crying wolf over
    // the user's own source.
    for (const content of [
      'Stream closed by the peer',
      'Tool permission request failed for an unrelated reason',
      null,
      42,
    ]) {
      expect(permissionFailure(content)).toEqual([
        expect.objectContaining({ type: 'tool_result' }),
      ]);
    }
  });

  it('does NOT fire when a tool result merely QUOTES the sentence further down', () => {
    // Measured, not hypothetical. On a real 47-minute run this fired three
    // times, every one of them a sub-agent `Read`ing geniro's own source: the
    // marker constants live in `claude.const.ts` and `spawn-cli.ts` quotes the
    // CLI's sentence verbatim in a doc block, so reading either one reported
    // that claude's permission channel had died. Twelve matches in that
    // daemon's log, and not one genuine CLI failure among them.
    //
    // The first line is what discriminates: the failing tool's result IS the
    // sentence and arrives alone, while a file that documents it has content
    // above it.
    const readOfThisRepo = [
      '330\tconst settlesOnTerminalEvent = opts.stdinLifetime === 0;',
      '331\t  /** they carried 165 of the 181 `Tool permission request failed:',
      '332\t   * AbortError: Stream closed` failures (10.4% here). */',
    ].join('\n');

    expect(permissionFailure(readOfThisRepo)).toEqual([
      expect.objectContaining({ type: 'tool_result' }),
    ]);
  });

  it('still fires when the sentence is the whole result, blank lines and all', () => {
    // The other side of the first-line rule: a leading newline must not hide a
    // genuine failure. Losing this is worse than the false positive it fixes —
    // it is the 239-unremarked-failures bug coming back.
    expect(
      permissionFailure(
        '\n\nTool permission request failed: AbortError: Stream closed',
      ),
    ).toEqual([
      expect.objectContaining({ type: 'tool_result' }),
      expect.objectContaining({ type: 'notice' }),
    ]);
  });

  it('requires both markers in ONE text leaf, not merely somewhere in the payload', () => {
    // The detector reads text leaves; it does NOT serialize the payload. Two
    // unrelated blocks each carrying one half are not the CLI's sentence, and
    // the old `JSON.stringify(content)` search called them one. Restore it and
    // this fires.
    expect(
      permissionFailure([
        { type: 'text', text: 'Tool permission request failed' },
        { type: 'text', text: 'Stream closed' },
      ]),
    ).toEqual([expect.objectContaining({ type: 'tool_result' })]);
  });

  it('does not read prose out of an image block, which is what the scan was narrowed for', () => {
    // The worst case of the whole-payload stringify: a base64 image result
    // serialized in full so two short markers could be searched for in bytes
    // that cannot carry prose. Matching here would also be a false positive —
    // an image is not the permission channel reporting anything.
    expect(
      permissionFailure([
        {
          type: 'image',
          source: {
            data: 'Tool permission request failed: AbortError: Stream closed',
          },
        },
      ]),
    ).toEqual([expect.objectContaining({ type: 'tool_result' })]);
  });

  it('still finds the sentence when the result is an object carrying a text field', () => {
    // The third shape the narrowing kept — asserted so a later "simplify to
    // strings and arrays" cannot drop it silently.
    expect(
      permissionFailure({
        text: 'Tool permission request failed: AbortError: Stream closed',
      }),
    ).toEqual([
      expect.objectContaining({ type: 'tool_result' }),
      expect.objectContaining({ type: 'notice' }),
    ]);
  });

  it('maps a successful result to turn_complete with the usage readClaudeUsage derives', () => {
    expect(
      mapClaudeMessage({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'pong',
        stop_reason: 'end_turn',
        usage: {
          // Turn-wide roll-up: three requests' worth of the same conversation.
          input_tokens: 12,
          output_tokens: 3,
          cache_creation_input_tokens: 100,
          cache_read_input_tokens: 2_700,
          iterations: [
            {
              input_tokens: 4,
              output_tokens: 3,
              cache_creation_input_tokens: 12,
              cache_read_input_tokens: 996,
            },
          ],
        },
        modelUsage: {
          'claude-opus-5[1m]': {
            inputTokens: 12,
            cacheReadInputTokens: 2_700,
            contextWindow: 1_000_000,
          },
        },
        total_cost_usd: 0.14,
      }),
    ).toEqual([
      {
        type: 'turn_complete',
        usage: {
          inputTokens: 12,
          outputTokens: 3,
          // The final request's prompt (4 + 12 + 996), not the 2_812 roll-up.
          contextTokens: 1012,
          contextWindowTokens: 1_000_000,
          contextModel: expect.any(String),
          costUsd: 0.14,
        },
        stopReason: 'end_turn',
        finalText: 'pong',
      },
    ]);
  });

  it('drops a result that reports no work at all', () => {
    // The CLI emits this at the START of a resumed turn, before any output of
    // that turn. Mapping it to a completion planted a `✓ done · $0.0000` under
    // the user's message, zeroed the context meter, and marked the turn
    // terminated — so the real work that followed got no completion and its
    // cost was never counted.
    expect(
      mapClaudeMessage({
        type: 'result',
        is_error: false,
        result: null,
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0 },
        total_cost_usd: 0,
      }),
    ).toEqual([]);
  });

  it('keeps a completion that reports a stop reason but no tokens', () => {
    // The drop is narrow on purpose: only a result saying NOTHING is discarded,
    // so a real completion can never be swallowed by it.
    const [event] = mapClaudeMessage({
      type: 'result',
      is_error: false,
      result: null,
      stop_reason: 'end_turn',
      usage: { input_tokens: 0, output_tokens: 0 },
      total_cost_usd: 0,
    });
    expect(event).toMatchObject({
      type: 'turn_complete',
      stopReason: 'end_turn',
    });
  });

  it('maps an error result to an error event', () => {
    expect(
      mapClaudeMessage({
        type: 'result',
        is_error: true,
        result: 'context limit exceeded',
      }),
    ).toEqual([{ type: 'error', message: 'context limit exceeded' }]);
  });

  it('ignores unknown event types and non-objects', () => {
    expect(mapClaudeMessage({ type: 'rate_limit_event', tier: 'x' })).toEqual(
      [],
    );
    expect(mapClaudeMessage('garbage')).toEqual([]);
    expect(mapClaudeMessage(null)).toEqual([]);
    expect(mapClaudeMessage(42)).toEqual([]);
  });
});

describe('mapClaudeMessage — the control dialogue (ask mode)', () => {
  it('maps a can_use_tool control_request to an approval_request event', () => {
    expect(mapClaudeMessage(JSON.parse(CONTROL_REQUEST))).toEqual([
      {
        type: 'approval_request',
        id: 'req-1',
        toolName: 'Write',
        input: { file_path: 'a.txt' },
      },
    ]);
  });

  it('carries requires_user_interaction — the question-vs-permission discriminator (M4)', () => {
    const events = mapClaudeMessage({
      type: 'control_request',
      request_id: 'req-q',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'AskUserQuestion',
        input: { questions: [] },
        requires_user_interaction: true,
      },
    });
    expect(events).toEqual([
      expect.objectContaining({
        type: 'approval_request',
        toolName: 'AskUserQuestion',
        requiresUserInteraction: true,
      }),
    ]);
    // A plain permission carries no flag — the event must not fake one.
    const plain = mapClaudeMessage(JSON.parse(CONTROL_REQUEST));
    expect(
      (plain[0] as { requiresUserInteraction?: boolean })
        .requiresUserInteraction,
    ).toBeUndefined();
  });

  it('lifts message.usage off a REAL assistant line as live context', () => {
    // Captured verbatim from `claude -p --output-format stream-json --verbose`
    // on 2.1.220 (2026-07-29), trimmed to the fields under test. Fabricating
    // this line would pin our own guess about the CLI, not the CLI.
    const events = mapClaudeMessage({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'A teapot.' }],
        usage: {
          input_tokens: 2,
          cache_creation_input_tokens: 36569,
          cache_read_input_tokens: 18366,
          output_tokens: 1,
          service_tier: 'standard',
        },
      },
    });
    // Prompt side only — output tokens are not context — and cache traffic
    // counts, because on a resumed session it IS the context.
    expect(events).toEqual([
      { type: 'context_progress', contextTokens: 2 + 36569 + 18366 },
      { type: 'text', text: 'A teapot.' },
    ]);
  });

  it('emits no context event for an assistant line that carries no usage', () => {
    // A CLI build that omits it must degrade to "the meter waits", never to a
    // zero that reads as an empty context.
    expect(
      mapClaudeMessage({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'hi' }] },
      }),
    ).toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('returns an unmodelled control subtype as data instead of dropping it', () => {
    // The mapper is pure and cannot log, so the ONLY way an
    // unrecognized subtype becomes visible is by leaving the function. If this
    // ever goes back to `[]` the daemon is silently blind again.
    expect(
      mapClaudeMessage({
        type: 'control_request',
        request_id: 'r',
        request: { subtype: 'initialize' },
      }),
    ).toEqual([{ type: 'unhandled_control', subtype: 'initialize' }]);
  });

  it('reports a control_request with no readable subtype rather than swallowing it', () => {
    expect(
      mapClaudeMessage({ type: 'control_request', request_id: 'r' }),
    ).toEqual([{ type: 'unhandled_control', subtype: '<none>' }]);
  });
});

describe('mapClaudeMessage — sub-agent origin', () => {
  /**
   * Captured verbatim from `claude -p --output-format stream-json --verbose` on
   * 2.1.226 (2026-08-10), from a turn that launched one sub-agent, trimmed to
   * the fields under test. The whole defect is that these lines are
   * indistinguishable from main-thread ones, so a fabricated fixture would pin
   * our guess about the CLI rather than the CLI.
   *
   * In that capture `parent_tool_use_id` appeared on the 12 `assistant`/`user`
   * lines and nowhere else: null on the 9 main-thread ones, and set to the id
   * of the `Agent` tool call on the 3 the sub-agent produced.
   */
  const AGENT_TOOL_USE_ID = 'toolu_01GffB3XLs9hgFTpZLrsex4f';

  it('marks a sub-agent tool call with the call that started it', () => {
    expect(
      mapClaudeMessage({
        type: 'assistant',
        parent_tool_use_id: AGENT_TOOL_USE_ID,
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'toolu_01W3VZjfLcUZ1wi9o3NJD7sW',
              name: 'Bash',
              input: { command: 'echo hello-from-subagent' },
            },
          ],
        },
      }),
    ).toEqual([
      {
        type: 'tool_call',
        id: 'toolu_01W3VZjfLcUZ1wi9o3NJD7sW',
        name: 'Bash',
        input: { command: 'echo hello-from-subagent' },
        parentToolUseId: AGENT_TOOL_USE_ID,
      },
    ]);
  });

  it('leaves a main-thread line unmarked, rather than stamping a null', () => {
    // `parent_tool_use_id: null` is what the CLI sends for the ordinary case,
    // and it must not become a key on every row in the database.
    const events = mapClaudeMessage({
      type: 'assistant',
      parent_tool_use_id: null,
      message: { content: [{ type: 'text', text: 'done.' }] },
    });
    expect(events).toEqual([{ type: 'text', text: 'done.' }]);
    expect(events[0]).not.toHaveProperty('parentToolUseId');
  });

  it('marks a sub-agent tool RESULT too, so a pair stays together', () => {
    // The result arrives on a `user` line, a different arm of the switch —
    // which is exactly why the stamp is applied around the switch and not
    // inside one case.
    expect(
      mapClaudeMessage({
        type: 'user',
        parent_tool_use_id: AGENT_TOOL_USE_ID,
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_01W3VZjfLcUZ1wi9o3NJD7sW',
              content: 'hello-from-subagent',
            },
          ],
        },
      }),
    ).toEqual([
      {
        type: 'tool_result',
        id: 'toolu_01W3VZjfLcUZ1wi9o3NJD7sW',
        name: null,
        result: 'hello-from-subagent',
        isError: false,
        parentToolUseId: AGENT_TOOL_USE_ID,
      },
    ]);
  });

  it('does NOT report a sub-agent request as the conversation’s context', () => {
    // THE METER BUG. A sub-agent's own request is a fresh, nearly empty
    // context; reporting it dropped the pill to a few thousand tokens and the
    // next main-thread line snapped it back. The usage below is deliberately
    // well-formed — dropping it is a decision about WHOSE context it is, not a
    // parse failure.
    const events = mapClaudeMessage({
      type: 'assistant',
      parent_tool_use_id: AGENT_TOOL_USE_ID,
      message: {
        content: [{ type: 'text', text: 'looking' }],
        usage: {
          input_tokens: 4,
          cache_creation_input_tokens: 11_000,
          cache_read_input_tokens: 0,
          output_tokens: 9,
        },
      },
    });
    expect(events.some((event) => event.type === 'context_progress')).toBe(
      false,
    );
    expect(events).toEqual([
      { type: 'text', text: 'looking', parentToolUseId: AGENT_TOOL_USE_ID },
    ]);
  });

  it('treats an EMPTY parent id as the main thread, not as a sub-agent', () => {
    // `asString` passes `''` straight through, so without normalization this
    // line would suppress the context meter for the whole turn and persist as
    // a sub-agent row — while the renderer half of the twin rejects `''` and
    // calls the same row the main thread's. Two readings of one shape must not
    // disagree about who wrote it.
    const events = mapClaudeMessage({
      type: 'assistant',
      parent_tool_use_id: '',
      message: {
        content: [{ type: 'text', text: 'hi' }],
        usage: { input_tokens: 7, cache_read_input_tokens: 3 },
      },
    });
    expect(events).toContainEqual({
      type: 'context_progress',
      contextTokens: 10,
    });
    expect(events.every((event) => !('parentToolUseId' in event))).toBe(true);
  });

  it('still reports the MAIN thread’s context from the same shape', () => {
    // The companion to the test above: without this pair, gating the meter on
    // "has no parent" and gating it on "always off" look identical.
    const events = mapClaudeMessage({
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        content: [{ type: 'text', text: 'looking' }],
        usage: {
          input_tokens: 4,
          cache_creation_input_tokens: 11_000,
          cache_read_input_tokens: 0,
          output_tokens: 9,
        },
      },
    });
    expect(events).toContainEqual({
      type: 'context_progress',
      contextTokens: 4 + 11_000,
    });
  });
});

describe('mapClaudeStreamEvent', () => {
  it('lifts an assistant text increment', () => {
    expect(mapClaudeStreamEvent(textDelta('The sea'))).toEqual([
      { type: 'text_delta', text: 'The sea' },
    ]);
  });

  it('ignores a tool argument stream — a large Write would cross twice', () => {
    expect(
      mapClaudeStreamEvent({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '{"content":"…' },
        },
      }),
    ).toEqual([]);
  });

  it('ignores a thinking increment — headless claude redacts the text', () => {
    // Captured verbatim: the body is empty and only a token estimate rides
    // along, so there is nothing to stream.
    expect(
      mapClaudeStreamEvent({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'thinking_delta',
            thinking: '',
            estimated_tokens: 150,
          },
        },
      }),
    ).toEqual([]);
  });

  it('ignores block and message framing', () => {
    for (const type of [
      'message_start',
      'message_delta',
      'message_stop',
      'content_block_start',
      'content_block_stop',
    ]) {
      expect(
        mapClaudeStreamEvent({ type: 'stream_event', event: { type } }),
      ).toEqual([]);
    }
  });

  it('survives a malformed or empty envelope rather than failing the turn', () => {
    expect(mapClaudeStreamEvent({ type: 'stream_event' })).toEqual([]);
    expect(
      mapClaudeStreamEvent({ type: 'stream_event', event: 'nope' }),
    ).toEqual([]);
    expect(mapClaudeStreamEvent(textDelta(''))).toEqual([]);
  });
});

describe('mapClaudeMessage — context compaction', () => {
  it('reads the boundary the CLI emits after compacting', () => {
    // The metadata shape is the CLI's own schema (2.1.226):
    // `{ trigger: 'manual'|'auto', pre_tokens, post_tokens? }`.
    expect(
      mapClaudeMessage({
        type: 'system',
        subtype: 'compact_boundary',
        session_id: 's1',
        compact_metadata: {
          trigger: 'auto',
          pre_tokens: 180_000,
          post_tokens: 32_000,
        },
      }),
    ).toEqual([
      {
        type: 'context_compacted',
        phase: 'finished',
        trigger: 'auto',
        preTokens: 180_000,
        postTokens: 32_000,
      },
    ]);
  });

  it('still reports the compaction when the metadata is absent or partial', () => {
    // The EVENT is the point — it is what explains the context meter dropping.
    // A boundary carrying no numbers must not be swallowed for lack of them.
    expect(
      mapClaudeMessage({ type: 'system', subtype: 'compact_boundary' }),
    ).toEqual([
      {
        type: 'context_compacted',
        phase: 'finished',
        trigger: null,
        preTokens: null,
        postTokens: null,
      },
    ]);
    expect(
      mapClaudeMessage({
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: { trigger: 'manual' },
      }),
    ).toEqual([
      {
        type: 'context_compacted',
        phase: 'finished',
        trigger: 'manual',
        preTokens: null,
        postTokens: null,
      },
    ]);
  });

  it('reads the LIVE status line the CLI emits when compaction starts', () => {
    // Captured verbatim on 2.1.227 from a persistent stream-json session (see
    // CLAUDE_STATUS_SUBTYPE). Before this arm existed the line fell through the
    // subtype checks and returned [], so a 46-second compaction was announced as
    // nothing at all — the reported defect.
    expect(
      mapClaudeMessage({
        type: 'system',
        subtype: 'status',
        status: 'compacting',
        session_id: 's1',
      }),
    ).toEqual([
      {
        type: 'context_compacted',
        phase: 'started',
        // No counts: nothing has been dropped yet, and this line carries no
        // `compact_metadata` to invent them from.
        trigger: null,
        preTokens: null,
        postTokens: null,
      },
    ]);
  });

  it('says out loud when a compaction FAILED, with the reason the CLI gave', () => {
    // The terminating status line, captured verbatim. A silent failure leaves
    // the user waiting on a compaction that never happened, still at full
    // context — so unlike the success path this one earns a durable row.
    expect(
      mapClaudeMessage({
        type: 'system',
        subtype: 'status',
        status: null,
        compact_result: 'failed',
        compact_error: 'Not enough messages to compact.',
        session_id: 's1',
      }),
    ).toEqual([
      {
        type: 'notice',
        message:
          'the conversation was not compacted — Not enough messages to compact.',
      },
      // The second event is what takes down the present-tense phrase `started`
      // put up. Drop it and the live row keeps saying "compacting the
      // conversation" after the CLI has already refused — only the SUCCESS path
      // emits a boundary to supersede it.
      {
        type: 'context_compacted',
        phase: 'failed',
        trigger: null,
        preTokens: null,
        postTokens: null,
      },
    ]);
  });

  it('states the failure without a reason when the CLI gave none', () => {
    // The defensive branch: `compact_result:'failed'` with no `compact_error`.
    // Unpinned, a later "always append the reason" tidy-up ships a dangling
    // " — " or the word "undefined" in a user-facing notice.
    expect(
      mapClaudeMessage({
        type: 'system',
        subtype: 'status',
        status: null,
        compact_result: 'failed',
        session_id: 's1',
      }),
    ).toEqual([
      { type: 'notice', message: 'the conversation was not compacted' },
      {
        type: 'context_compacted',
        phase: 'failed',
        trigger: null,
        preTokens: null,
        postTokens: null,
      },
    ]);
  });

  it('says nothing on the SUCCESS status line — the boundary and summary speak', () => {
    // Asserted because the obvious implementation announces both ends of the
    // status pair; a success notice would duplicate the boundary event AND the
    // summary row, giving three lines for one compaction.
    expect(
      mapClaudeMessage({
        type: 'system',
        subtype: 'status',
        status: null,
        compact_result: 'success',
        session_id: 's1',
      }),
    ).toEqual([]);
  });

  it('surfaces the CLI’s own compaction summary as a system row', () => {
    // Item 2. Captured verbatim: the summary arrives as a `user` line whose
    // `content` is a plain STRING, and the block loop that arm runs sees nothing
    // in a string — which is why the summary never reached the transcript.
    expect(
      mapClaudeMessage({
        type: 'user',
        message: {
          role: 'user',
          content:
            'This session is being continued from a previous conversation…\n\nSummary: the user asked for numbers.',
        },
        isReplay: false,
        isSynthetic: true,
        session_id: 's1',
      }),
    ).toEqual([
      {
        type: 'notice',
        message:
          'This session is being continued from a previous conversation…\n\nSummary: the user asked for numbers.',
        // The CLI wrote this, not the daemon. Without the marker the renderer
        // paints it in the failure chrome every other notice earns, so a relayed
        // summary reads as geniro reporting an error — and untrusted text could
        // then impersonate an application-level advisory.
        origin: 'cli',
      },
    ]);
  });

  it('leaves the daemon’s OWN notices unmarked, so their rows do not change', () => {
    // The other side of the `origin` contract: only CLI-authored text carries it.
    // A daemon advisory must stay exactly the shape it was, or every existing
    // notice's transcript row changes appearance with this diff.
    const events = mapClaudeMessage({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            content:
              'Tool permission request failed: AbortError: Stream closed',
          },
        ],
      },
      session_id: 's1',
    });
    const notice = events.find((event) => event.type === 'notice');
    expect(notice).toBeDefined();
    expect(notice && 'origin' in notice).toBe(false);
  });

  it('ignores a REPLAYED synthetic line, so a resume cannot re-persist the summary', () => {
    // This fixture is deliberately `isSynthetic: true` AND `isReplay: true` —
    // the only shape that the replay half of the guard actually decides. With
    // `isSynthetic` omitted the test would pass with `!asBoolean(root.isReplay)`
    // deleted from production, since the synthetic check alone already fails it:
    // a false pin, and the duplicate of the real-user-message test below.
    //
    // What it protects: a resumed session replays the preserved segment, so
    // without the replay guard the summary would be lifted again and persisted
    // once more on every resume.
    expect(
      mapClaudeMessage({
        type: 'user',
        message: {
          role: 'user',
          content:
            'This session is being continued from a previous conversation…',
        },
        isReplay: true,
        isSynthetic: true,
        session_id: 's1',
      }),
    ).toEqual([]);
  });

  it('ignores the replayed `<local-command-stdout>` line beside the summary', () => {
    // The other half of the captured burst, verbatim. Distinct from the case
    // above: this one is a replay that carries NO `isSynthetic`, so it is barred
    // twice over — worth keeping as the shape actually observed on the wire.
    expect(
      mapClaudeMessage({
        type: 'user',
        message: {
          role: 'user',
          content: '<local-command-stdout>Compacted </local-command-stdout>',
        },
        isReplay: true,
        session_id: 's1',
      }),
    ).toEqual([]);
  });

  it('never lifts a REAL user message into a system row', () => {
    // The guard that keeps this from surfacing the user's own words back at
    // them: a genuine user line is not synthetic. Drop the isSynthetic check and
    // this fails.
    expect(
      mapClaudeMessage({
        type: 'user',
        message: { role: 'user', content: 'please fix the login bug' },
        session_id: 's1',
      }),
    ).toEqual([]);
  });

  it('leaves the other system subtypes alone', () => {
    // The compaction arm is keyed on its own subtype, so `init` must still map
    // to the session/commands/model events it always did.
    expect(
      mapClaudeMessage({
        type: 'system',
        subtype: 'init',
        session_id: 's1',
      }),
    ).toEqual([{ type: 'session', sessionId: 's1' }]);
  });
});

describe('mapClaudeThinkingTokens', () => {
  it('reads the running reasoning total off the telemetry line', () => {
    // Captured verbatim from a live turn.
    expect(
      mapClaudeThinkingTokens({
        type: 'system',
        subtype: 'thinking_tokens',
        estimated_tokens: 300,
        estimated_tokens_delta: 100,
      }),
    ).toEqual([{ type: 'thinking_progress', tokens: 300 }]);
  });

  it('reports nothing when there is no usable total', () => {
    expect(mapClaudeThinkingTokens({ type: 'system' })).toEqual([]);
    expect(mapClaudeThinkingTokens({ estimated_tokens: 0 })).toEqual([]);
    expect(mapClaudeThinkingTokens({ estimated_tokens: 'lots' })).toEqual([]);
  });
});
