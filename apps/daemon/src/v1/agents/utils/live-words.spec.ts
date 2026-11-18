import { describe, expect, it } from 'vitest';

import type { AgentEvent } from '../adapters/adapter.types';
import { endsReasoningStretch } from './live-words';

const DELEGATE_SETTLED: AgentEvent = {
  type: 'subagent_info',
  id: 'toolu_fork',
  label: null,
  kind: null,
  prompt: null,
  model: 'claude-fable-5-2',
  durationMs: 295316,
  tokens: 375173,
  toolUses: 32,
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheCreationTokens: null,
  costUsd: null,
  stepsUnavailableReason: null,
  backgroundOpen: false,
  backgroundOutcome: 'completed',
};

describe('endsReasoningStretch', () => {
  it.each<[string, AgentEvent]>([
    ['a background delegate settling', DELEGATE_SETTLED],
    [
      'a background unit settling',
      {
        type: 'background_work',
        id: 'task_1',
        phase: 'settled',
        unit: 'other',
        toolCallId: 'toolu_fork',
        outcome: 'completed',
      },
    ],
    [
      'a command detaching',
      { type: 'shell_open', toolCallId: 'toolu_sh', workId: 'bash_1' },
    ],
    [
      'a detached command ending',
      { type: 'shell_info', toolCallId: 'toolu_sh', workId: 'bash_1' },
    ],
    [
      'a workflow reporting its roster',
      {
        type: 'workflow_info',
        id: 'toolu_wf',
        name: null,
        title: null,
        activity: 'reviewing',
        tokens: 1200,
        toolUses: 3,
        durationMs: 4000,
        agents: null,
      },
    ],
    [
      'a call returning',
      {
        type: 'tool_result',
        id: 'toolu_sh',
        name: 'Bash',
        result: 'ok',
        isError: false,
      },
    ],
  ])('keeps the stretch open on %s', (_, event) => {
    expect(endsReasoningStretch(event)).toBe(false);
  });

  it.each<[string, AgentEvent]>([
    ['a tool call', { type: 'tool_call', id: 't1', name: 'Bash', input: {} }],
    ['its words', { type: 'text', text: 'Done.' }],
    ['its reasoning row', { type: 'reasoning', text: 'Weighing the forks' }],
    ['its turn held on background work', { type: 'turn_held', open: 2 }],
    [
      'a failed request',
      { type: 'notice', message: 'API Error', severity: 'warning' },
    ],
  ])('ends the stretch on %s', (_, event) => {
    expect(endsReasoningStretch(event)).toBe(true);
  });

  it("keeps the stretch open on a delegate's own row", () => {
    expect(
      endsReasoningStretch({
        type: 'tool_call',
        id: 'td',
        name: 'Read',
        input: {},
        parentToolUseId: 'toolu_fork',
      }),
    ).toBe(false);
  });
});
