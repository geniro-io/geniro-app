import { COLD_RESUME_RULE } from '../../../graphs/utils/prompt-cache-standing';

/** What a model reads about `list_agent_threads`. */
export function listAgentThreadsInstructions(): string {
  return (
    'List YOUR conversations with your call-wired agents — one entry per conversation (an agent instance), with the call_id to pass as `thread` to continue it, whether a call is running on it, how full its context is, and where its prompt cache stands (warm until `expires_at`, `expired`, or `unknown` for a CLI that reports none). ' +
    'Use it BEFORE you continue an earlier conversation with call_agent(thread), above all after a pause (the user came back later, you were woken much later): ' +
    `${COLD_RESUME_RULE} Each entry's "advice" applies that rule: continue, start_fresh, or busy (a call is still running on it — use message_agent or await_agent). ` +
    'Do not use it to collect results (await_agent does) or to find out who you can call (your "May call" list says).'
  );
}
