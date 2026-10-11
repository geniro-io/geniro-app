import { MIN_AWAIT_TIMEOUT_MS } from '../../../graphs/graphs.types';

/**
 * `await_agent`'s arguments.
 *
 * `waitWindow` is the window THIS caller's waits actually get — below its own
 * CLI's tool-call deadline — so the listing does not promise a cursor caller
 * the 240s a claude caller has.
 */
export function awaitAgentSchema(waitWindow: number): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      call_id: {
        type: 'string',
        description:
          'The call_id an async call_agent returned. Omit it to wait on all of your open calls at once.',
      },
      timeout_ms: {
        type: 'integer',
        minimum: MIN_AWAIT_TIMEOUT_MS,
        maximum: waitWindow,
        description:
          `How long to wait before answering {"status":"pending"} instead, ${MIN_AWAIT_TIMEOUT_MS}-${waitWindow}ms, in MILLISECONDS. ` +
          `Omitted, it is ${waitWindow}ms — the longest a wait can last before the connection carrying it is cut — ` +
          'so a slow callee answers "pending" and you simply await it again.',
      },
    },
  };
}
