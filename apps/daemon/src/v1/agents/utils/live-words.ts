import type { AgentEvent, LiveWordsEvent } from '../adapters/adapter.types';

/** Whether the event belongs on the live plane's words or reasoning, never on a row. */
export function isLiveWordsEvent(event: AgentEvent): event is LiveWordsEvent {
  return (
    event.type === 'text_delta' ||
    event.type === 'thinking_progress' ||
    event.type === 'reasoning_delta'
  );
}

const REPORTS_ON_WORK_BESIDE_THE_AGENT: ReadonlySet<AgentEvent['type']> =
  new Set([
    'subagent_info',
    'background_work',
    'shell_open',
    'shell_info',
    'workflow_info',
    'tool_result',
  ]);

/** Whether the event shows the agent itself has stopped reasoning. */
export function endsReasoningStretch(event: AgentEvent): boolean {
  return (
    event.parentToolUseId === undefined &&
    !REPORTS_ON_WORK_BESIDE_THE_AGENT.has(event.type)
  );
}
