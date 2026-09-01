import { asRecord, asString } from '../../utils/json-util';

/**
 * JSON-RPC 2.0 framing for ACP over stdio: line-delimited JSON, one message
 * per line. Pure functions only — the driver owns all protocol state.
 */

/** A JSON-RPC id. ACP agents may use either form; both must round-trip exactly. */
export type JsonRpcId = string | number;

/** Standard JSON-RPC error code for an unimplemented method. */
export const JSONRPC_METHOD_NOT_FOUND = -32601;

/** One decoded incoming message, discriminated by what we must do with it. */
export type IncomingMessage =
  | { kind: 'response'; id: JsonRpcId; result: unknown }
  | { kind: 'error'; id: JsonRpcId; message: string }
  | { kind: 'request'; id: JsonRpcId; method: string; params: unknown }
  | { kind: 'notification'; method: string; params: unknown }
  | { kind: 'unknown' };

/**
 * The category and its detail as one sentence, without repeating either.
 *
 * A detail that is empty, or that already contains the category (or the reverse
 * — some agents put the whole sentence in both fields), collapses to the single
 * string rather than to `Invalid params: Invalid params`.
 */
function joinErrorDetail(message: string, detail: string | null): string {
  const extra = detail?.trim();
  if (!extra || message.includes(extra) || extra.includes(message)) {
    return extra && extra.includes(message) ? extra : message;
  }
  return `${message}: ${extra}`;
}

function asJsonRpcId(value: unknown): JsonRpcId | null {
  if (typeof value === 'string') {
    return value;
  }
  // Only finite numbers: a NaN/Infinity id cannot be serialized back.
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Classify one parsed stdout line. A message carrying `method` is inbound work
 * (a request when it also carries an id, a notification when it does not);
 * anything else carrying an id is a reply to something we sent. Everything
 * unrecognized degrades to `unknown` rather than throwing — the same posture
 * every other CLI mapper in this module takes toward version drift.
 */
export function classifyMessage(obj: unknown): IncomingMessage {
  const root = asRecord(obj);
  if (!root) {
    return { kind: 'unknown' };
  }

  const method = asString(root.method);
  const id = asJsonRpcId(root.id);

  if (method !== null) {
    return id === null
      ? { kind: 'notification', method, params: root.params }
      : { kind: 'request', id, method, params: root.params };
  }
  if (id === null) {
    return { kind: 'unknown' };
  }
  const error = asRecord(root.error);
  if (error) {
    const message = asString(error.message);
    const code = error.code;
    return {
      kind: 'error',
      id,
      message: joinErrorDetail(
        message ??
          `json-rpc error ${typeof code === 'number' ? code : 'without a message'}`,
        // JSON-RPC's own `message` is the CATEGORY — the spec reserves the
        // -32602 range and agents spell it exactly "Invalid params" — while
        // `data.message` is the only field that says WHICH parameter and why.
        // Reading the category alone left every refusal in the transcript as
        // the bare words `Invalid params`, which names nothing the user could
        // act on; the reply that produced this change also carried
        // `Invalid value for effort: max`, which names the whole problem.
        asString(asRecord(error.data)?.message),
      ),
    };
  }
  // A result of `null` is a legitimate success reply (ACP notifications-as-acks
  // do this), so key on the property's presence, not its truthiness.
  return 'result' in root
    ? { kind: 'response', id, result: root.result }
    : { kind: 'unknown' };
}

function frame(message: Record<string, unknown>): string {
  return `${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`;
}

export function encodeRequest(
  id: JsonRpcId,
  method: string,
  params: unknown,
): string {
  return frame({ id, method, params });
}

/**
 * A notification — a method call with NO id, so the peer must not answer it.
 *
 * The id is what makes a JSON-RPC frame a request, so this is not a cosmetic
 * difference: `session/cancel` sent with one would leave the agent owing a
 * reply the protocol never defined, and this client's own pending map holding
 * an entry nothing can ever settle.
 */
export function encodeNotification(method: string, params: unknown): string {
  return frame({ method, params });
}

export function encodeResult(id: JsonRpcId, result: unknown): string {
  return frame({ id, result });
}

export function encodeError(
  id: JsonRpcId,
  code: number,
  message: string,
): string {
  return frame({ id, error: { code, message } });
}

/**
 * Tag a JSON-RPC id so it survives the round-trip through `AgentEvent`, whose
 * approval id is a `string` while a JSON-RPC id may be a number. Encoding the
 * ORIGINAL type in the tag lets `decodeRequestId` reproduce it exactly — a
 * reply carrying `"7"` where the agent sent `7` is an unmatched reply, and the
 * agent stays parked forever. A lookup map would work too, but this keeps the
 * verdict path pure and testable with no per-turn state to miss.
 */
export function encodeRequestId(id: JsonRpcId): string {
  return typeof id === 'number' ? `n:${id}` : `s:${id}`;
}

/** Inverse of {@link encodeRequestId}; null when the tag is absent or malformed. */
export function decodeRequestId(encoded: string): JsonRpcId | null {
  if (encoded.startsWith('s:')) {
    return encoded.slice(2);
  }
  if (encoded.startsWith('n:')) {
    const value = Number(encoded.slice(2));
    return Number.isFinite(value) ? value : null;
  }
  return null;
}
