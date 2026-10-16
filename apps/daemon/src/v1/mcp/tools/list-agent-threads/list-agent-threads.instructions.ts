import { COLD_RESUME_RULE } from '../../../graphs/utils/prompt-cache-standing';

/** What a model reads about `list_agent_threads`. */
export function listAgentThreadsInstructions(): string {
  return (
    'List YOUR conversations with your call-wired agents — one entry per conversation (an agent instance): `thread`, the call_id to pass as call_agent `thread` to continue it (null while its only call is still running); `status`, `running` (with its `running_call` — use message_agent or await_agent on it) or `idle`; `context`, how big its context was at its last turn — `tokens`, and when its model reported its window, that `window` and the `percent` of it in use (no `context` when no token count was reported); and `cache`, where its prompt cache stands (warm until `expires_at`, `expired`, or `unknown` for a CLI that reports none). `resume_refused: "CACHE_EXPIRED"` marks an entry the refusal below applies to. ' +
    'Use it BEFORE you continue an earlier conversation with call_agent(thread), above all after a pause (the user came back later, you were woken much later): ' +
    `${COLD_RESUME_RULE} ` +
    'Do not use it to collect results (await_agent does) or to find out who you can call (your "May call" list says).'
  );
}
