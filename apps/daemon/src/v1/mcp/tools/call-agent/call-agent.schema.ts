import { CALL_MODES } from '../../../graphs/graphs.types';
import { COLD_RESUME_CONTEXT_PERCENT } from '../../../graphs/utils/prompt-cache-standing';
import { MAX_CALL_TITLE_LENGTH } from './call-agent.reader';

/** `call_agent`'s arguments. */
export function callAgentSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      agent: {
        type: 'string',
        description:
          'The callee — its node id or display name from your "May call" list.',
      },
      message: {
        type: 'string',
        description:
          'The task for the callee. Without `thread` it starts a FRESH conversation seeing only this text (plus its own role) — include all context it needs.',
      },
      title: {
        type: 'string',
        description: `A short, human-readable reason for this call — WHY you are making it (e.g. "Get concrete UAT links from the DB"), shown to the user on the call's card. Not the task itself. At most ${MAX_CALL_TITLE_LENGTH} characters.`,
      },
      thread: {
        type: 'string',
        description: `Optional: a previous call_id of YOUR call to this same agent — the callee CONTINUES that conversation with its full memory. Omit to start a new thread. Before continuing a conversation after a pause, check it with list_agent_threads: one whose prompt cache has EXPIRED and whose context is over ${COLD_RESUME_CONTEXT_PERCENT}% full is refused (CACHE_EXPIRED), because resuming it re-bills the whole context uncached — start a new instance with a self-contained brief instead.`,
      },
      resume_cold: {
        type: 'boolean',
        description:
          'Optional, with `thread`: continue the conversation even though its cache has expired and its context is large. Only when its history is worth re-billing in full; otherwise start a new instance.',
      },
      mode: {
        type: 'string',
        enum: [...CALL_MODES],
        description:
          'async (preferred) returns a call_id at once — keep working or end your turn, you are notified when it finishes or asks, then collect it with await_agent; sync (the default when omitted) blocks until the result; fire_and_forget never returns a result.',
      },
      member: {
        type: 'integer',
        minimum: 1,
        description:
          'Optional, only when the user requests a specific member of an "agent pool" (CLI, model, or account): its member number, with no handing on to another member if it fails. Otherwise omit to use the first available member in priority order. A thread always continues on the member that ran it.',
      },
    },
    required: ['agent', 'message', 'title'],
  };
}
