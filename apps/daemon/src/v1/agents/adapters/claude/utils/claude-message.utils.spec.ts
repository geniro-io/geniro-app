import { describe, expect, it } from 'vitest';

import type { AgentEvent } from '../../adapter.types';
import {
  mapClaudeMessage,
  mapClaudeStreamEvent,
  mapClaudeThinkingTokens,
} from './claude-message.utils';
import { ClaudeSessionCostLedger } from './claude-usage.utils';

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
      mapClaudeMessage(
        {
          type: 'system',
          subtype: 'init',
          session_id: 'sess-1',
        },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([{ type: 'session', sessionId: 'sess-1' }]);
  });

  it('harvests init slash_commands alongside the session id, dropping non-strings', () => {
    expect(
      mapClaudeMessage(
        {
          type: 'system',
          subtype: 'init',
          session_id: 'sess-1',
          slash_commands: ['review', 42, '', 'compact'],
        },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([
      { type: 'session', sessionId: 'sess-1' },
      {
        type: 'slash_commands',
        // Names and nothing else: the field is an array of plain strings, so
        // every entry reports a null description and the sentence beside it
        // in the popup comes from this CLI's disk scan instead.
        commands: [
          { name: 'review', description: null },
          { name: 'compact', description: null },
        ],
      },
    ]);
  });

  it('harvests init mcp_servers with the state each was in', () => {
    // Captured verbatim from a live 2.1.222 turn. This is the whole point of
    // the MCP harvest: the panel's alternative is `claude mcp list`, which
    // HEALTH-CHECKS — it dials, and therefore starts, every configured server
    // from cold (6.7s measured against nine of them). A wrong field name here
    // ships green and silently leaves the panel on that cold path.
    expect(
      mapClaudeMessage(
        {
          type: 'system',
          subtype: 'init',
          session_id: 'sess-1',
          mcp_servers: [
            { name: 'codegraph', status: 'connected' },
            { name: 'ticktick', status: 'pending' },
            { name: 'claude.ai n8n', status: 'failed' },
          ],
        },
        new ClaudeSessionCostLedger(),
      ),
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
    const [event] = mapClaudeMessage(
      {
        type: 'system',
        subtype: 'init',
        mcp_servers: [{ name: 'probe-server', status: 'disabled' }],
      },
      new ClaudeSessionCostLedger(),
    );

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
    const [event] = mapClaudeMessage(
      {
        type: 'system',
        subtype: 'init',
        mcp_servers: [
          { name: 'reworded', status: 'needs-auth' },
          { name: 'no-status' },
          { status: 'connected' },
          'not-an-object',
        ],
      },
      new ClaudeSessionCostLedger(),
    );

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
      mapClaudeMessage(
        {
          type: 'system',
          subtype: 'init',
          session_id: 'sess-1',
          model: 'claude-opus-5[1m]',
        },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([
      { type: 'session', sessionId: 'sess-1' },
      { type: 'turn_model', model: 'claude-opus-5[1m]' },
    ]);
  });

  it('says nothing about the model when init names none', () => {
    expect(
      mapClaudeMessage(
        { type: 'system', subtype: 'init', model: 42 },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([]);
  });

  it('ignores non-init system events (hook_*, post_turn_summary)', () => {
    expect(
      mapClaudeMessage(
        { type: 'system', subtype: 'hook_started' },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([]);
    expect(
      mapClaudeMessage(
        { type: 'system', subtype: 'post_turn_summary' },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([]);
  });

  it('maps assistant text/thinking/tool_use blocks in order', () => {
    const events = mapClaudeMessage(
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'let me think' },
            { type: 'text', text: 'hello' },
            { type: 'tool_use', id: 't1', name: 'Read', input: { path: '/x' } },
          ],
        },
      },
      new ClaudeSessionCostLedger(),
    );
    expect(events).toEqual([
      { type: 'reasoning', text: 'let me think' },
      { type: 'text', text: 'hello' },
      { type: 'tool_call', id: 't1', name: 'Read', input: { path: '/x' } },
    ]);
  });

  it('maps a user tool_result block', () => {
    expect(
      mapClaudeMessage(
        {
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
        },
        new ClaudeSessionCostLedger(),
      ),
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
    mapClaudeMessage(
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't9', content, is_error: true },
          ],
        },
      },
      new ClaudeSessionCostLedger(),
    );

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
      mapClaudeMessage(
        {
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
          session_id: 'sess-result',
          total_cost_usd: 0.14,
          duration_ms: 7618,
          duration_api_ms: 7176,
        },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([
      {
        type: 'turn_complete',
        usage: {
          inputTokens: 12,
          outputTokens: 3,
          // The other two thirds of the same roll-up, cumulative like the
          // input count beside them — NOT the last request's 12/996, which is
          // what `contextTokens` below is built from.
          cacheReadTokens: 2_700,
          cacheCreationTokens: 100,
          // This fixture's result carries no `output_tokens_details`, and a
          // build that reports none must read as unknown rather than as a turn
          // that thought nothing.
          thinkingTokens: null,
          // The final request's prompt (4 + 12 + 996), not the 2_812 roll-up.
          contextTokens: 1012,
          contextWindowTokens: 1_000_000,
          contextModel: expect.any(String),
          costUsd: 0.14,
          // The CLI's own turn timing, carried through the mapper to the turn
          // the transcript persists — the number that lets a finished turn say
          // how long it worked instead of only what it cost.
          durationMs: 7618,
          apiMs: 7176,
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
      mapClaudeMessage(
        {
          type: 'result',
          is_error: false,
          result: null,
          stop_reason: null,
          usage: { input_tokens: 0, output_tokens: 0 },
          total_cost_usd: 0,
        },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([]);
  });

  it('keeps a completion that reports a stop reason but no tokens', () => {
    // The drop is narrow on purpose: only a result saying NOTHING is discarded,
    // so a real completion can never be swallowed by it.
    const [event] = mapClaudeMessage(
      {
        type: 'result',
        is_error: false,
        result: null,
        stop_reason: 'end_turn',
        usage: { input_tokens: 0, output_tokens: 0 },
        total_cost_usd: 0,
      },
      new ClaudeSessionCostLedger(),
    );
    expect(event).toMatchObject({
      type: 'turn_complete',
      stopReason: 'end_turn',
    });
  });

  it('drops a no-work result whose text is EMPTY rather than absent', () => {
    // Reconstructed from the author's own geniro.db + debug log (2026-08-18,
    // 2.1.234, run 4144f28e, twice in 40 minutes): `status?` was answered with
    // `✓ done · 0s · $0.0000` and nothing above it, 2.7s after it was sent. The
    // CLI's own session file shows the turn it ran in that window was a
    // `<task-notification>` it had queued for itself, not the user's prompt —
    // so the line was the absence of an answer, and `result: ""` rather than
    // `result: null` is the only reason it was read as one.
    expect(
      mapClaudeMessage(
        {
          type: 'result',
          is_error: false,
          result: '',
          stop_reason: null,
          usage: { input_tokens: 0, output_tokens: 0 },
          total_cost_usd: 0,
          duration_ms: 35,
          duration_api_ms: 0,
        },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([]);
  });

  it('keeps a wordless completion that did REAL work', () => {
    // The other half of the narrowness: a turn can legitimately end with no
    // sentence — it ran tools and stopped — and that one has token counts. Only
    // a line reporting nothing at all is discarded.
    const [event] = mapClaudeMessage(
      {
        type: 'result',
        is_error: false,
        result: '',
        stop_reason: null,
        usage: { input_tokens: 1_200, output_tokens: 8 },
        total_cost_usd: 0.02,
      },
      new ClaudeSessionCostLedger(),
    );
    expect(event).toMatchObject({ type: 'turn_complete' });
  });

  it('maps an error result to an error event', () => {
    expect(
      mapClaudeMessage(
        {
          type: 'result',
          is_error: true,
          result: 'context limit exceeded',
        },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([{ type: 'error', message: 'context limit exceeded' }]);
  });

  it('names the CLI’s own subtype when an error result carries no sentence', () => {
    // The exact line a user was handed: `{type:'result', is_error:true}` with
    // no `result` and no `error`, rendered as three words that answer nothing
    // — reported back as "i have error, i dont know why". The subtype is the
    // only thing the line does say, and it is searchable.
    expect(
      mapClaudeMessage(
        {
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
        },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([
      {
        type: 'error',
        message: 'claude run failed (error_during_execution)',
        // …and the same word as a FIELD, which is what a reader can search
        // and a report can carry without the sentence around it.
        detail: { code: 'error_during_execution' },
      },
    ]);
  });

  it('keeps the CLI’s own sentence alone when it has one', () => {
    // A subtype appended to an explanation is machine noise on the end of it.
    expect(
      mapClaudeMessage(
        {
          type: 'result',
          subtype: 'error_max_turns',
          is_error: true,
          result: 'reached the turn limit',
        },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([
      {
        type: 'error',
        message: 'reached the turn limit',
        detail: { code: 'error_max_turns' },
      },
    ]);
  });

  it('ignores unknown event types and non-objects', () => {
    expect(
      mapClaudeMessage(
        { type: 'rate_limit_event', tier: 'x' },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([]);
    expect(mapClaudeMessage('garbage', new ClaudeSessionCostLedger())).toEqual(
      [],
    );
    expect(mapClaudeMessage(null, new ClaudeSessionCostLedger())).toEqual([]);
    expect(mapClaudeMessage(42, new ClaudeSessionCostLedger())).toEqual([]);
  });
});

describe('mapClaudeMessage — the control dialogue (ask mode)', () => {
  it('maps a can_use_tool control_request to an approval_request event', () => {
    expect(
      mapClaudeMessage(
        JSON.parse(CONTROL_REQUEST),
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([
      {
        type: 'approval_request',
        id: 'req-1',
        toolName: 'Write',
        input: { file_path: 'a.txt' },
      },
    ]);
  });

  it('carries requires_user_interaction — the question-vs-permission discriminator (M4)', () => {
    const events = mapClaudeMessage(
      {
        type: 'control_request',
        request_id: 'req-q',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'AskUserQuestion',
          input: { questions: [] },
          requires_user_interaction: true,
        },
      },
      new ClaudeSessionCostLedger(),
    );
    expect(events).toEqual([
      expect.objectContaining({
        type: 'approval_request',
        toolName: 'AskUserQuestion',
        requiresUserInteraction: true,
      }),
    ]);
    // A plain permission carries no flag — the event must not fake one.
    const plain = mapClaudeMessage(
      JSON.parse(CONTROL_REQUEST),
      new ClaudeSessionCostLedger(),
    );
    expect(
      (plain[0] as { requiresUserInteraction?: boolean })
        .requiresUserInteraction,
    ).toBeUndefined();
  });

  it('lifts message.usage off a REAL assistant line as live context', () => {
    // Captured verbatim from `claude -p --output-format stream-json --verbose`
    // on 2.1.220 (2026-07-29), trimmed to the fields under test. Fabricating
    // this line would pin our own guess about the CLI, not the CLI.
    const events = mapClaudeMessage(
      {
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
      },
      new ClaudeSessionCostLedger(),
    );
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
      mapClaudeMessage(
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'hi' }] },
        },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('returns an unmodelled control subtype as data instead of dropping it', () => {
    // The mapper is pure and cannot log, so the ONLY way an
    // unrecognized subtype becomes visible is by leaving the function. If this
    // ever goes back to `[]` the daemon is silently blind again.
    expect(
      mapClaudeMessage(
        {
          type: 'control_request',
          request_id: 'r',
          request: { subtype: 'initialize' },
        },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([{ type: 'unhandled_control', subtype: 'initialize' }]);
  });

  it('reports a control_request with no readable subtype rather than swallowing it', () => {
    expect(
      mapClaudeMessage(
        { type: 'control_request', request_id: 'r' },
        new ClaudeSessionCostLedger(),
      ),
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
      mapClaudeMessage(
        {
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
        },
        new ClaudeSessionCostLedger(),
      ),
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
    const events = mapClaudeMessage(
      {
        type: 'assistant',
        parent_tool_use_id: null,
        message: { content: [{ type: 'text', text: 'done.' }] },
      },
      new ClaudeSessionCostLedger(),
    );
    expect(events).toEqual([{ type: 'text', text: 'done.' }]);
    expect(events[0]).not.toHaveProperty('parentToolUseId');
  });

  it('marks a sub-agent tool RESULT too, so a pair stays together', () => {
    // The result arrives on a `user` line, a different arm of the switch —
    // which is exactly why the stamp is applied around the switch and not
    // inside one case.
    expect(
      mapClaudeMessage(
        {
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
        },
        new ClaudeSessionCostLedger(),
      ),
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
    const events = mapClaudeMessage(
      {
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
      },
      new ClaudeSessionCostLedger(),
    );
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
    const events = mapClaudeMessage(
      {
        type: 'assistant',
        parent_tool_use_id: '',
        message: {
          content: [{ type: 'text', text: 'hi' }],
          usage: { input_tokens: 7, cache_read_input_tokens: 3 },
        },
      },
      new ClaudeSessionCostLedger(),
    );
    expect(events).toContainEqual({
      type: 'context_progress',
      contextTokens: 10,
    });
    expect(events.every((event) => !('parentToolUseId' in event))).toBe(true);
  });

  it('still reports the MAIN thread’s context from the same shape', () => {
    // The companion to the test above: without this pair, gating the meter on
    // "has no parent" and gating it on "always off" look identical.
    const events = mapClaudeMessage(
      {
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
      },
      new ClaudeSessionCostLedger(),
    );
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
      mapClaudeMessage(
        {
          type: 'system',
          subtype: 'compact_boundary',
          session_id: 's1',
          compact_metadata: {
            trigger: 'auto',
            pre_tokens: 180_000,
            post_tokens: 32_000,
          },
        },
        new ClaudeSessionCostLedger(),
      ),
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
      mapClaudeMessage(
        { type: 'system', subtype: 'compact_boundary' },
        new ClaudeSessionCostLedger(),
      ),
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
      mapClaudeMessage(
        {
          type: 'system',
          subtype: 'compact_boundary',
          compact_metadata: { trigger: 'manual' },
        },
        new ClaudeSessionCostLedger(),
      ),
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
      mapClaudeMessage(
        {
          type: 'system',
          subtype: 'status',
          status: 'compacting',
          session_id: 's1',
        },
        new ClaudeSessionCostLedger(),
      ),
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
      mapClaudeMessage(
        {
          type: 'system',
          subtype: 'status',
          status: null,
          compact_result: 'failed',
          compact_error: 'Not enough messages to compact.',
          session_id: 's1',
        },
        new ClaudeSessionCostLedger(),
      ),
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
      mapClaudeMessage(
        {
          type: 'system',
          subtype: 'status',
          status: null,
          compact_result: 'failed',
          session_id: 's1',
        },
        new ClaudeSessionCostLedger(),
      ),
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
      mapClaudeMessage(
        {
          type: 'system',
          subtype: 'status',
          status: null,
          compact_result: 'success',
          session_id: 's1',
        },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([]);
  });

  it('surfaces the CLI’s own compaction summary as a system row', () => {
    // Item 2. Captured verbatim: the summary arrives as a `user` line whose
    // `content` is a plain STRING, and the block loop that arm runs sees nothing
    // in a string — which is why the summary never reached the transcript.
    expect(
      mapClaudeMessage(
        {
          type: 'user',
          message: {
            role: 'user',
            content:
              'This session is being continued from a previous conversation…\n\nSummary: the user asked for numbers.',
          },
          isReplay: false,
          isSynthetic: true,
          session_id: 's1',
        },
        new ClaudeSessionCostLedger(),
      ),
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
    const events = mapClaudeMessage(
      {
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
      },
      new ClaudeSessionCostLedger(),
    );
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
      mapClaudeMessage(
        {
          type: 'user',
          message: {
            role: 'user',
            content:
              'This session is being continued from a previous conversation…',
          },
          isReplay: true,
          isSynthetic: true,
          session_id: 's1',
        },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([]);
  });

  it('ignores the replayed `<local-command-stdout>` line beside the summary', () => {
    // The other half of the captured burst, verbatim. Distinct from the case
    // above: this one is a replay that carries NO `isSynthetic`, so it is barred
    // twice over — worth keeping as the shape actually observed on the wire.
    expect(
      mapClaudeMessage(
        {
          type: 'user',
          message: {
            role: 'user',
            content: '<local-command-stdout>Compacted </local-command-stdout>',
          },
          isReplay: true,
          session_id: 's1',
        },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([]);
  });

  it('never lifts a REAL user message into a system row', () => {
    // The guard that keeps this from surfacing the user's own words back at
    // them: a genuine user line is not synthetic. Drop the isSynthetic check and
    // this fails.
    expect(
      mapClaudeMessage(
        {
          type: 'user',
          message: { role: 'user', content: 'please fix the login bug' },
          session_id: 's1',
        },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([]);
  });

  it('leaves the other system subtypes alone', () => {
    // The compaction arm is keyed on its own subtype, so `init` must still map
    // to the session/commands/model events it always did.
    expect(
      mapClaudeMessage(
        {
          type: 'system',
          subtype: 'init',
          session_id: 's1',
        },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([{ type: 'session', sessionId: 's1' }]);
  });
});

describe('mapClaudeMessage — background tasks', () => {
  // Every line below is captured verbatim from a 2.1.231 turn told to launch a
  // delegate and NOT wait for it. What makes them load-bearing: that same run
  // printed TWO `result` lines — the user's answer, and then a turn claude ran
  // on its own accord once a task reported (`origin:{kind:"task-notification"}`)
  // — so a turn settled on the first `result` is settled mid-work.
  it('opens a unit of background work on task_started', () => {
    expect(
      mapClaudeMessage(
        {
          type: 'system',
          subtype: 'task_started',
          task_id: 'ad83f0a35d8a3dfc9',
          tool_use_id: 'toolu_01LWpVdfmqPnsMuftxq7YiAA',
          description: 'Delayed sleep echo task',
          subagent_type: 'general-purpose',
          task_type: 'local_agent',
          session_id: 's1',
        },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([
      {
        type: 'background_work',
        id: 'ad83f0a35d8a3dfc9',
        phase: 'started',
        // A DELEGATE, and the call that launched it — what lets the transcript
        // keep that sub-agent's block open past the instant return.
        unit: 'agent',
        toolCallId: 'toolu_01LWpVdfmqPnsMuftxq7YiAA',
      },
    ]);
  });

  it('does not call a delegate’s own shell command a delegate', () => {
    // Probed 2026-08-17 on 2.1.232: ONE Task call produced two `task_started`
    // lines — the delegate, and the `sleep` that delegate then ran. Both are
    // background work the turn must outlive; reading the second as a sub-agent
    // would report two where the user launched one.
    expect(
      mapClaudeMessage(
        {
          type: 'system',
          subtype: 'task_started',
          task_id: 'bx0yxbert',
          owned_by_subagent: true,
          tool_use_id: 'toolu_01JGZBzkWjmavxf5ztmdNu83',
          description: 'Sleep for 20 seconds',
          task_type: 'local_bash',
          session_id: 's1',
        },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([
      {
        type: 'background_work',
        id: 'bx0yxbert',
        phase: 'started',
        unit: 'other',
        toolCallId: 'toolu_01JGZBzkWjmavxf5ztmdNu83',
      },
    ]);
  });

  it('closes it from EITHER terminal channel, which spell the status differently', () => {
    // `task_updated` carries it in a patch, `task_notification` at the root —
    // and the same task was reported `killed` by one and `stopped` by the other
    // in one measured run, which is why neither spelling is trusted alone.
    expect(
      mapClaudeMessage(
        {
          type: 'system',
          subtype: 'task_updated',
          task_id: 'ad83f0a35d8a3dfc9',
          patch: { status: 'completed', end_time: 1786635753021 },
        },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([
      {
        type: 'background_work',
        id: 'ad83f0a35d8a3dfc9',
        phase: 'settled',
        // A settle states neither: the consumer matches it against what the
        // 'started' recorded, which is the only line that says what a unit is.
        unit: 'other',
        toolCallId: null,
      },
    ]);
    expect(
      mapClaudeMessage(
        {
          type: 'system',
          subtype: 'task_notification',
          task_id: 'bblzv799n',
          status: 'stopped',
          tool_use_id: 'toolu_x',
        },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([
      {
        type: 'background_work',
        id: 'bblzv799n',
        phase: 'settled',
        unit: 'other',
        // This channel DOES name the call; the other does not, which is why the
        // consumer never depends on either naming it.
        toolCallId: 'toolu_x',
      },
    ]);
    expect(
      mapClaudeMessage(
        {
          type: 'system',
          subtype: 'task_updated',
          task_id: 'bblzv799n',
          patch: { status: 'killed', end_time: 1786635772095 },
        },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([
      {
        type: 'background_work',
        id: 'bblzv799n',
        phase: 'settled',
        unit: 'other',
        toolCallId: null,
      },
    ]);
  });

  it('carries what the unit SPENT off the notification that settles it', () => {
    // The figures behind "in front of each agent i wanna see amount of
    // tokens/costs/time". Probed on 2.1.237 against a real delegation: the
    // notification is the only channel that states them, and it states exactly
    // these three keys.
    expect(
      mapClaudeMessage(
        {
          type: 'system',
          subtype: 'task_notification',
          task_id: 'a71b21049ece3b941',
          status: 'completed',
          tool_use_id: 'toolu_01J4EGWm9tNfE1hQGUYw7TSj',
          usage: { total_tokens: 26124, tool_uses: 0, duration_ms: 2029 },
        },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([
      {
        type: 'background_work',
        id: 'a71b21049ece3b941',
        phase: 'settled',
        unit: 'other',
        toolCallId: 'toolu_01J4EGWm9tNfE1hQGUYw7TSj',
        usage: { tokens: 26124, toolUses: 0, durationMs: 2029 },
      },
    ]);
  });

  it('says NOTHING about spend on a settle whose channel carries none', () => {
    // `task_updated` is an id and a status patch, and this daemon maps both
    // channels on purpose so a CLI dropping one still settles. An absent block
    // therefore has to claim nothing rather than report zeros — the consumer
    // merges announcements by preferring the last non-null field, and a record
    // of nulls arriving second is indistinguishable from a measurement.
    const [event] = mapClaudeMessage(
      {
        type: 'system',
        subtype: 'task_updated',
        task_id: 'ad83f0a35d8a3dfc9',
        patch: { status: 'completed' },
      },
      new ClaudeSessionCostLedger(),
    );
    expect(event).toMatchObject({ type: 'background_work', phase: 'settled' });
    expect(
      (event as Extract<AgentEvent, { type: 'background_work' }>).usage,
    ).toBeUndefined();
  });

  it('leaves the work OPEN for a status it does not recognise', () => {
    // The direction is the point: an unrecognised status delays a settle
    // (bounded by the turn's silence deadline) rather than declaring work
    // finished while it is still running, which is the whole defect.
    expect(
      mapClaudeMessage(
        {
          type: 'system',
          subtype: 'task_updated',
          task_id: 't1',
          patch: { status: 'reticulating_splines' },
        },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([]);
    // `task_progress` is the in-flight ping and carries no status at all.
    expect(
      mapClaudeMessage(
        {
          type: 'system',
          subtype: 'task_progress',
          task_id: 't1',
          description: 'Running sleep 40 && echo delegate-finished-late',
          last_tool_name: 'Bash',
        },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([]);
    expect(
      mapClaudeMessage(
        {
          type: 'system',
          subtype: 'task_notification',
          task_id: 't1',
        },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([]);
  });

  it('reports nothing for a task line carrying no id', () => {
    // Identity is the whole content of the event — the set is keyed by it — so
    // an id-less line is unusable rather than a unit of anonymous work.
    expect(
      mapClaudeMessage(
        { type: 'system', subtype: 'task_started' },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([]);
    expect(
      mapClaudeMessage(
        {
          type: 'system',
          subtype: 'task_notification',
          status: 'completed',
        },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([]);
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

describe('mapClaudeMessage — what a failed turn reports about itself', () => {
  it('carries the provider’s own account of an API failure', () => {
    // Transcribed from a live 2.1.234 failure (`--model
    // definitely-not-a-model`), fields verbatim. Every one of these was on the
    // wire and dropped: the row reached the user as one sentence with nothing
    // in it anyone could look up.
    expect(
      mapClaudeMessage(
        {
          type: 'result',
          is_error: true,
          terminal_reason: 'api_error',
          api_error_status: 404,
          session_id: '99691942-8ca6-415d-a4c5-975ed3aa4b73',
          duration_ms: 986,
          subtype: 'success',
          result: 'There’s an issue with the selected model.',
        },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([
      {
        type: 'error',
        message: 'There’s an issue with the selected model.',
        detail: {
          // `terminal_reason`, NOT `subtype`: the line above says
          // `"subtype":"success"` on a failure, which is exactly why appending
          // it to the sentence was misleading.
          code: 'api_error',
          httpStatus: 404,
          sessionId: '99691942-8ca6-415d-a4c5-975ed3aa4b73',
          durationMs: 986,
        },
      },
    ]);
  });

  it('tells a turn the CLI ABORTED from one it rejected', () => {
    // The reported failure, verbatim from the screenshot: no sentence of its
    // own, so the row read `claude run failed (aborted_streaming)` — machine
    // noise naming neither what happened nor what to do. The CLI's own source
    // puts this reason in an abort family it explicitly excludes from its error
    // family, and its own consumer logs it at ordinary level.
    const [event] = mapClaudeMessage(
      {
        type: 'result',
        is_error: true,
        terminal_reason: 'aborted_streaming',
        session_id: 'a2a059b3-3212-4fe5-b5a8-a08cd117fd0a',
        duration_ms: 24322,
        subtype: 'success',
      },
      new ClaudeSessionCostLedger(),
    );

    expect(event).toMatchObject({ type: 'error' });
    const message = (event as { message: string }).message;
    expect(message).not.toContain('claude run failed');
    expect(message).toContain('stopped this turn before it finished');
    // The code is NOT dropped — it moves into the facts table, which is where a
    // bug report reads it from.
    expect(event).toMatchObject({ detail: { code: 'aborted_streaming' } });
  });

  it('keeps the CLI’s own sentence even when the turn was aborted', () => {
    // Same rule as every other failure here: geniro speaks only where the CLI
    // said nothing.
    expect(
      mapClaudeMessage(
        {
          type: 'result',
          is_error: true,
          terminal_reason: 'aborted_tools',
          result: 'Streaming stopped while a tool was running.',
        },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([
      {
        type: 'error',
        message: 'Streaming stopped while a tool was running.',
        detail: { code: 'aborted_tools' },
      },
    ]);
  });

  it('says nothing extra when the CLI reported nothing extra', () => {
    // A CLI that carries none of it must produce the row it always produced —
    // an empty `detail` object would put a blank table under every failure.
    expect(
      mapClaudeMessage(
        { type: 'result', is_error: true, result: 'it broke' },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([{ type: 'error', message: 'it broke' }]);
  });
});

describe('an api-error assistant line', () => {
  /** The shape read off the author's own session store — see the predicate. */
  const apiErrorLine = (
    code: string,
    text: string,
  ): Record<string, unknown> => ({
    type: 'assistant',
    error: code,
    request_id: 'req_011CeHzsz3E8dXUXzFMFsqZu',
    is_api_error_message: true,
    message: {
      role: 'assistant',
      model: '<synthetic>',
      content: [{ type: 'text', text }],
      usage: { input_tokens: 41234, output_tokens: 12 },
    },
  });

  it('is the daemon reporting a failed request, never the agent talking', () => {
    expect(
      mapClaudeMessage(
        apiErrorLine(
          'server_error',
          'API Error: Connection closed mid-response. The response above may be incomplete.',
        ),
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([
      {
        type: 'notice',
        message:
          'API Error: Connection closed mid-response. The response above may be incomplete.',
        severity: 'warning',
        caption: 'api error',
      },
    ]);
  });

  it('never relays it as CLI-authored text, which picks the quiet chrome', () => {
    // `origin: 'cli'` is for text the AGENT wrote, and the renderer drops a
    // severity beside it — so stamping it here would put the report back in
    // prose chrome, one step from the assistant bubble this replaced.
    const [notice] = mapClaudeMessage(
      apiErrorLine('rate_limit', "You've hit your weekly limit · resets 4pm"),
      new ClaudeSessionCostLedger(),
    );

    expect(notice).toEqual({
      type: 'notice',
      message: "You've hit your weekly limit · resets 4pm",
      severity: 'warning',
      caption: 'api error',
    });
    expect(notice).not.toHaveProperty('origin');
  });

  it('publishes no window reading off a synthetic failure line', () => {
    // The usage on it belongs to a request that FAILED. Lifting it would move
    // the composer's meter on the strength of a request that produced nothing.
    expect(
      mapClaudeMessage(
        apiErrorLine('server_error', 'Request timed out'),
        new ClaudeSessionCostLedger(),
      ).filter((event) => event.type === 'context_progress'),
    ).toEqual([]);
  });

  it('leaves an ORDINARY assistant line alone', () => {
    // The flag is the whole discriminator: the envelope is identical, and
    // `request_id` rides ordinary lines too.
    expect(
      mapClaudeMessage(
        {
          type: 'assistant',
          request_id: 'req_011CeHzsz3E8dXUXzFMFsqZu',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'API Error: is what I would say' }],
          },
        },
        new ClaudeSessionCostLedger(),
      ),
    ).toEqual([{ type: 'text', text: 'API Error: is what I would say' }]);
  });
});
