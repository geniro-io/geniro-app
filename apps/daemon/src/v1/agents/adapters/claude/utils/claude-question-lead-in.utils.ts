import { asRecord, asString } from '../../../utils/json-util';
import type { AgentEvent } from '../../adapter.types';
import {
  CLAUDE_QUESTION_TOOL_NAME,
  CLAUDE_SUMMARIZED_LEAD_IN_MAX_CHARS,
  CLAUDE_SUMMARIZED_LEAD_IN_NOTICE,
} from '../claude.const';

/** Kept per turn: which question cards were preceded by a summarized lead-in. */
export class ClaudeQuestionLeadIn {
  private collected: string[] = [];
  private pendingQuestion: string | null = null;
  private readonly byRequest = new Map<string, string>();

  observe(obj: unknown, events: AgentEvent[]): AgentEvent[] {
    if (asString(asRecord(obj)?.parent_tool_use_id)) {
      return events;
    }
    for (const event of events) {
      if (event.parentToolUseId !== undefined) {
        continue;
      }
      switch (event.type) {
        case 'reasoning': {
          const text = event.text.trim();
          if (text) {
            this.collected.push(text);
          }
          break;
        }
        case 'text':
          this.collected = [];
          break;
        case 'tool_call':
          this.pendingQuestion =
            event.name === CLAUDE_QUESTION_TOOL_NAME
              ? this.takeCollected()
              : null;
          this.collected = [];
          break;
        case 'approval_request':
          if (event.toolName === CLAUDE_QUESTION_TOOL_NAME) {
            const summary = this.pendingQuestion ?? this.takeCollected();
            if (summary !== null) {
              this.byRequest.set(event.id, summary);
            }
            this.pendingQuestion = null;
            this.collected = [];
          }
          break;
        default:
          break;
      }
    }
    return events;
  }

  withNotice(id: string, allow: boolean, updatedInput: unknown): unknown {
    const summary = this.byRequest.get(id);
    if (summary === undefined) {
      return updatedInput;
    }
    this.byRequest.delete(id);
    return allow
      ? appendToAnswer(updatedInput, leadInNotice(summary))
      : updatedInput;
  }

  private takeCollected(): string | null {
    return this.collected.length > 0 ? this.collected.join('\n\n') : null;
  }
}

function leadInNotice(summary: string): string {
  const quoted =
    summary.length > CLAUDE_SUMMARIZED_LEAD_IN_MAX_CHARS
      ? `${summary.slice(0, CLAUDE_SUMMARIZED_LEAD_IN_MAX_CHARS - 1).trimEnd()}…`
      : summary;
  return CLAUDE_SUMMARIZED_LEAD_IN_NOTICE.replace('%summary', () => quoted);
}

function appendToAnswer(input: unknown, notice: string): unknown {
  const root = asRecord(input);
  if (!root) {
    return input;
  }
  if (typeof root.response === 'string') {
    return { ...root, response: `${root.response}\n\n${notice}` };
  }
  const answers = asRecord(root.answers);
  const [question, ...rest] = answers ? Object.keys(answers) : [];
  const answer = question === undefined ? undefined : answers?.[question];
  if (question === undefined || rest.length > 0 || typeof answer !== 'string') {
    return input;
  }
  return { ...root, answers: { [question]: `${answer}\n\n${notice}` } };
}
