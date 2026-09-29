import { CODEX_CLIENT_NAME } from '../codex.const';

/**
 * The `initialize` params every `codex app-server` this adapter opens is sent —
 * a conversation's kept process and each one-shot listing alike, so the two
 * cannot come to disagree about what this client is.
 *
 * `experimentalApi` is what lets a turn carry a collaboration mode — plan mode
 * is one.
 */
export function codexInitializeParams(
  clientVersion: string,
): Record<string, unknown> {
  return {
    clientInfo: {
      name: CODEX_CLIENT_NAME,
      title: null,
      version: clientVersion,
    },
    capabilities: { experimentalApi: true, requestAttestation: false },
  };
}
