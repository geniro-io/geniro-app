import { asRecord } from '../../../utils/json-util';
import {
  classifyMessage,
  encodeNotification,
  encodeRequest,
} from '../../utils/json-rpc.utils';
import { CODEX_INITIALIZED_NOTIFICATION, CODEX_METHODS } from '../codex.const';
import { codexInitializeParams } from './codex-handshake.utils';

/** The id a one-shot's own request goes out under — the handshake takes 1. */
const ONESHOT_REQUEST_ID = 2;

/**
 * The frames that ask a fresh `codex app-server` ONE question: the handshake
 * and the request, written back to back. Measured on 0.157.1, the server reads
 * them in order and answers a `thread/list` 157ms after spawn.
 */
export function codexOneshotFrames(
  clientVersion: string,
  method: string,
  params: unknown,
): string[] {
  return [
    encodeRequest(
      1,
      CODEX_METHODS.initialize,
      codexInitializeParams(clientVersion),
    ),
    encodeNotification(CODEX_INITIALIZED_NOTIFICATION, {}),
    encodeRequest(ONESHOT_REQUEST_ID, method, params),
  ];
}

/** The one-shot's reply, or undefined while it has not arrived. */
function findReply(
  stdout: string,
): { ok: true; result: unknown } | { ok: false; message: string } | undefined {
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (asRecord(parsed)?.id !== ONESHOT_REQUEST_ID) {
      continue;
    }
    const message = classifyMessage(parsed);
    if (message.kind === 'response') {
      return { ok: true, result: message.result };
    }
    if (message.kind === 'error') {
      return { ok: false, message: message.message };
    }
  }
  return undefined;
}

/** `settleWhen` for a one-shot: its request has been answered either way. */
export function codexOneshotSettled(stdout: string): boolean {
  return findReply(stdout) !== undefined;
}

/**
 * What the one-shot's request answered: its result, the server's refusal, or
 * null when the output carries no reply at all (the process never answered).
 */
export function codexOneshotReply(
  stdout: string | null,
): { ok: true; result: unknown } | { ok: false; message: string } | null {
  return stdout === null ? null : (findReply(stdout) ?? null);
}
