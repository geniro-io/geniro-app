import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AUTO_FLAG_REFUSAL_WINDOW_MS,
  type AutomaticFlagInput,
} from '../../agents/chat.types';
import type { FlagBroker } from '../../agents/services/flag.broker';
import type { McpToolResult } from '../mcp.types';
import {
  type ServedToolCall,
  ToolFailureFlagsService,
} from './tool-failure-flags.service';

function setup() {
  const raised: { runId: string; input: AutomaticFlagInput }[] = [];
  const service = new ToolFailureFlagsService({
    raiseAutomatic: async (runId: string, input: AutomaticFlagInput) => {
      raised.push({ runId, input });
      return 'F-000001';
    },
  } as unknown as FlagBroker);
  return { raised, service };
}

const call = (over: Partial<ServedToolCall> = {}): ServedToolCall => ({
  runId: 'run-1',
  memberId: 'senior',
  conversationId: 'conv-1',
  endpointPath: '/v1/mcp/run-1/senior/conv-1',
  tool: 'browser_click',
  startedAt: Date.now(),
  ...over,
});

const ok = (text = 'done'): McpToolResult => ({
  content: [{ type: 'text', text }],
  isError: false,
});
const refused = (text = 'NO_SUCH_TAB: tab 3 is closed'): McpToolResult => ({
  content: [{ type: 'text', text }],
  isError: true,
});

describe('ToolFailureFlagsService', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts counting again after the third error answer', () => {
    const { raised, service } = setup();

    for (let index = 0; index < 5; index += 1) {
      service.answered(call(), refused());
    }
    expect(raised).toHaveLength(1);
    service.answered(call(), refused());

    expect(raised.map(({ input }) => input.cause)).toEqual([
      'tool_refused:browser_click',
      'tool_refused:browser_click',
    ]);
  });

  it('lets a streak lapse once its last error answer is older than the window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-26T10:00:00Z'));
    const { raised, service } = setup();

    service.answered(call(), refused());
    service.answered(call(), refused());
    vi.setSystemTime(
      new Date(
        Date.parse('2026-11-26T10:00:00Z') + AUTO_FLAG_REFUSAL_WINDOW_MS + 1,
      ),
    );
    service.answered(call(), refused());
    expect(raised).toEqual([]);
    service.answered(call(), refused());
    service.answered(call(), refused());

    expect(raised).toHaveLength(1);
    expect(raised[0]?.input.minutesLost).toBe(1);
  });

  it('flags a call that timed out with the tool, the message and the minutes it took', () => {
    const { raised, service } = setup();

    service.answered(call({ startedAt: Date.now() - 90_000 }), {
      ...refused('The browser operation took longer than 18 s'),
      failure: 'timeout',
    });

    expect(raised).toEqual([
      {
        runId: 'run-1',
        input: {
          cause: 'tool_failure:browser_click',
          seq: null,
          memberId: 'senior',
          conversationId: 'conv-1',
          summary: 'browser_click timed out',
          detail: 'The browser operation took longer than 18 s',
          minutesLost: 2,
        },
      },
    ]);
  });

  it('flags an internal failure and a thrown call as failures inside geniro', () => {
    const { raised, service } = setup();

    service.answered(call(), {
      ...refused('The browser operation failed: boom'),
      failure: 'internal',
    });
    service.threw(call({ tool: 'show_ui' }), new Error('db is locked'));

    expect(
      raised.map(({ input }) => [input.cause, input.summary, input.detail]),
    ).toEqual([
      [
        'tool_failure:browser_click',
        'browser_click failed inside geniro',
        'The browser operation failed: boom',
      ],
      ['tool_failure:show_ui', 'show_ui failed inside geniro', 'db is locked'],
    ]);
  });

  it('raises no failure flag for INVALID_ARGS or a refusal', () => {
    const { raised, service } = setup();

    service.answered(call(), refused('INVALID_ARGS: ref is required'));
    service.answered(call(), refused());

    expect(raised).toEqual([]);
  });

  it('flags the third error answer in a row of one tool in one conversation, with the minutes since the first', () => {
    const { raised, service } = setup();

    service.answered(
      call({ startedAt: Date.now() - 200_000 }),
      refused('first'),
    );
    service.answered(call(), refused('INVALID_ARGS: second'));
    expect(raised).toEqual([]);
    service.answered(call(), refused('third'));

    expect(raised).toEqual([
      {
        runId: 'run-1',
        input: {
          cause: 'tool_refused:browser_click',
          seq: null,
          memberId: 'senior',
          conversationId: 'conv-1',
          summary: 'browser_click refused 3 times running',
          detail: 'third',
          minutesLost: 4,
        },
      },
    ]);
  });

  it('starts the streak again after a success', () => {
    const { raised, service } = setup();

    service.answered(call(), refused());
    service.answered(call(), refused());
    service.answered(call(), ok());
    service.answered(call(), refused());
    service.answered(call(), refused());

    expect(raised).toEqual([]);
  });

  it('counts each conversation and each tool apart, and leaves failures out of the streak', () => {
    const { raised, service } = setup();
    const other = call({ endpointPath: '/v1/mcp/run-1/senior' });

    service.answered(call(), refused());
    service.answered(other, refused());
    service.answered(call({ tool: 'browser_type' }), refused());
    service.answered(call(), { ...refused(), failure: 'timeout' });
    service.answered(call(), refused());

    expect(raised.map(({ input }) => input.cause)).toEqual([
      'tool_failure:browser_click',
    ]);
  });
});
