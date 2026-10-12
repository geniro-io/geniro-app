import { asRecord, asString } from '../../../utils/json-util';
import type { AgentEvent } from '../../adapter.types';
import { CLAUDE_MODEL_MISMATCH_MESSAGE } from '../claude.const';
import { canonicalClaudeModel } from './claude-delegate-cost.utils';

/** Kept with the process; a result closes one turn's notice allowance. */
export class ClaudeModelMismatchNotice {
  private noticed = false;

  constructor(private readonly requestedModel?: string | null) {}

  onMessage(obj: unknown, events: AgentEvent[]): AgentEvent[] {
    const root = asRecord(obj);
    if (asString(root?.parent_tool_use_id)) {
      return events;
    }
    const notices: AgentEvent[] = [];
    const type = asString(root?.type);
    const message =
      type === 'assistant'
        ? asRecord(root?.message)
        : type === 'stream_event'
          ? asRecord(asRecord(root?.event)?.message)
          : null;
    notices.push(...this.compare(asString(message?.model)));
    for (const event of events) {
      if (event.parentToolUseId !== undefined) {
        continue;
      }
      if (event.type === 'turn_model') {
        notices.push(...this.compare(event.model));
      } else if (event.type === 'context_progress') {
        notices.push(...this.compare(event.contextModel));
      } else if (
        event.type === 'turn_complete' ||
        event.type === 'turn_cancelled' ||
        event.type === 'error'
      ) {
        notices.push(...this.compare(event.usage?.contextModel));
      }
    }
    if (type === 'result') {
      this.noticed = false;
    }
    return [...notices, ...events];
  }

  private compare(reportedModel?: string | null): AgentEvent[] {
    const requested = this.requestedModel?.trim();
    // The CLI's cached picker does not resolve tier aliases to account ids.
    // Comparing those guesses would warn on every ordinary opus/sonnet turn.
    if (
      this.noticed ||
      !requested?.startsWith('claude-') ||
      requested.endsWith('-latest') ||
      !reportedModel?.startsWith('claude-') ||
      canonicalClaudeModel(requested) === canonicalClaudeModel(reportedModel)
    ) {
      return [];
    }
    this.noticed = true;
    return [
      {
        type: 'notice',
        severity: 'info',
        message: CLAUDE_MODEL_MISMATCH_MESSAGE.replace(
          '%served',
          reportedModel,
        ).replace('%requested', requested),
      },
    ];
  }
}
