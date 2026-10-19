import { open, opendir, realpath } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';

import { asRecord, asString } from '../../../utils/json-util';
import type {
  RecoveredSubagentOutcome,
  SubagentRecoveryRef,
} from '../../adapter.types';
import {
  CODEX_RECOVERY_MAX_BYTES,
  CODEX_RECOVERY_MAX_DEPTH,
  CODEX_RECOVERY_MAX_ENTRIES,
  CODEX_RECOVERY_STORES,
  CODEX_THREAD_ID_PATTERN,
} from '../codex.const';

/** Read only an existing rollout; absence and unfinished records establish no outcome. */
export async function recoverCodexSubagent(
  ref: SubagentRecoveryRef,
  home: string,
): Promise<RecoveredSubagentOutcome | null> {
  if (
    ref.childSessionId === null ||
    !CODEX_THREAD_ID_PATTERN.test(ref.childSessionId) ||
    !CODEX_THREAD_ID_PATTERN.test(ref.sessionId) ||
    !Number.isFinite(ref.launchedAtMs)
  ) {
    return null;
  }
  try {
    const root = await realpath(home);
    const paths: string[] = [];
    let entries = 0;
    const visit = async (directory: string, depth: number): Promise<void> => {
      const canonical = await realpath(directory);
      const store = relative(root, canonical).split(sep)[0];
      if (!CODEX_RECOVERY_STORES.some((name) => name === store)) {
        return;
      }
      for await (const entry of await opendir(canonical)) {
        if (++entries > CODEX_RECOVERY_MAX_ENTRIES) {
          throw new Error('Codex recovery directory limit exceeded');
        }
        const path = join(canonical, entry.name);
        if (entry.isDirectory() && depth < CODEX_RECOVERY_MAX_DEPTH) {
          await visit(path, depth + 1);
        } else if (
          entry.isFile() &&
          entry.name.endsWith(`-${ref.childSessionId}.jsonl`)
        ) {
          paths.push(path);
        }
      }
    };
    for (const store of CODEX_RECOVERY_STORES) {
      try {
        await visit(join(root, store), 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
    }
    // Multiple copies can carry different continuations; choosing one would guess.
    if (paths.length !== 1) {
      return null;
    }
    const path = await realpath(paths[0]!);
    if (
      !CODEX_RECOVERY_STORES.some(
        (store) => relative(root, path).split(sep)[0] === store,
      ) ||
      !basename(path).endsWith(`-${ref.childSessionId}.jsonl`)
    ) {
      return null;
    }
    const handle = await open(path, 'r');
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > CODEX_RECOVERY_MAX_BYTES) {
        return null;
      }
      const buffer = Buffer.alloc(before.size + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const after = await handle.stat();
      if (
        bytesRead !== before.size ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs
      ) {
        return null;
      }
      return rolloutOutcome(
        buffer.subarray(0, bytesRead).toString('utf8'),
        ref,
      );
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

function rolloutOutcome(
  text: string,
  ref: SubagentRecoveryRef,
): RecoveredSubagentOutcome | null {
  // A writer may be midway through appending the next start boundary.
  if (!text.endsWith('\n')) {
    return null;
  }
  let identity = false;
  let turnId: string | null = null;
  let startedAt = Number.NaN;
  let outcome: RecoveredSubagentOutcome | null = null;
  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    const row = asRecord(JSON.parse(line) as unknown);
    const payload = asRecord(row?.payload);
    if (row === null || payload === null) {
      return null;
    }
    if (row.type === 'session_meta') {
      const spawn = asRecord(asRecord(payload.source)?.subagent);
      if (
        payload.id !== ref.childSessionId ||
        asRecord(spawn?.thread_spawn)?.parent_thread_id !== ref.sessionId
      ) {
        return null;
      }
      identity = true;
    } else if (row.type === 'event_msg') {
      if (payload.type === 'task_started') {
        turnId = asString(payload.turn_id);
        startedAt = Date.parse(asString(row.timestamp) ?? '');
        outcome = null;
      } else if (
        payload.type === 'task_complete' ||
        payload.type === 'turn_aborted'
      ) {
        const endedAt = Date.parse(asString(row.timestamp) ?? '');
        if (
          turnId === null ||
          payload.turn_id !== turnId ||
          !Number.isFinite(startedAt) ||
          !Number.isFinite(endedAt) ||
          endedAt < startedAt ||
          endedAt < ref.launchedAtMs
        ) {
          outcome = null;
          continue;
        }
        outcome =
          payload.type === 'task_complete'
            ? 'completed'
            : payload.reason === 'interrupted'
              ? 'stopped'
              : null;
      }
    }
  }
  return identity ? outcome : null;
}
