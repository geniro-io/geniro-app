import type { EntityManager } from '@mikro-orm/sqlite';

import type { NodeStateDao } from '../dao/node-state.dao';

/**
 * Changed-only persister for the CLI session id. Some CLIs repeat the session
 * id on every stream-json line, and `saveSessionId` costs a findOne+flush —
 * one DB round-trip per NDJSON chunk without this dedupe. Shared by the chat
 * turn and every graph node — extracted, never mirrored.
 */
export function createSessionIdSaver(
  dao: NodeStateDao,
  runId: string,
  nodeId: string,
  initial: string | null,
  em?: EntityManager,
): (sessionId: string) => Promise<void> {
  let saved = initial;
  return async (sessionId) => {
    if (sessionId === saved) {
      return;
    }
    saved = sessionId;
    await dao.saveSessionId(runId, nodeId, sessionId, em);
  };
}
