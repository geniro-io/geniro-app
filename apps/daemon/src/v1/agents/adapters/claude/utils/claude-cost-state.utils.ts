import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';

import { asNumber, asRecord, asString } from '../../../utils/json-util';
import { isPlainSessionId } from '../../../utils/session-id';
import {
  CLAUDE_COST_STATE_LINE_TYPE,
  CLAUDE_SESSION_FILE_SUFFIX,
  CLAUDE_SESSIONS_DIR_NAME,
} from '../claude.const';

/** The running totals a resumed claude process starts from. */
export interface ClaudeCostState {
  costUsd: number | null;
  apiMs: number | null;
}

/**
 * How much of a session file one backward read takes. A session's last
 * `cost-state` line sits behind everything a later, ungracefully-ended process
 * wrote, so the scan walks back chunk by chunk rather than reading a tail.
 */
const CHUNK_BYTES = 1024 * 1024;

/**
 * Where a session's transcript lives under a profile — `<profile>/projects/
 * <flattened cwd>/<id>.jsonl` — found by name across the profile's project
 * directories rather than by re-deriving the CLI's own flattening of the cwd.
 * Null for an id that is not a plain session id (it reaches a path) or a
 * session the profile does not hold.
 */
export function findClaudeSessionFileSync(
  profileDir: string,
  sessionId: string,
): string | null {
  if (!isPlainSessionId(sessionId)) {
    return null;
  }
  const root = join(profileDir, CLAUDE_SESSIONS_DIR_NAME);
  let dirs: string[];
  try {
    dirs = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const path = join(root, dir, `${sessionId}${CLAUDE_SESSION_FILE_SUFFIX}`);
    if (existsSync(path)) {
      return path;
    }
  }
  return null;
}

/**
 * The totals the CLI will restore when it resumes this session: the LAST
 * `cost-state` line of the session's own transcript.
 *
 * claude appends that line when a process ends gracefully, and `--resume`
 * starts the new process's running total from it — probed on 2.1.284: a
 * process ended at $0.0273, the resumed process's first result reported
 * $0.0329 for a turn that cost $0.0056. A process that was killed writes none,
 * and the next one restores the line before it, which is why the LAST one is
 * the answer however much was written after it. Null when the session holds
 * none — the resumed process then starts from zero.
 */
export function readLastClaudeCostState(
  path: string,
  sessionId: string,
): ClaudeCostState | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    let end = statSync(path).size;
    // Bytes of a line cut by the previous chunk's start, carried into this one.
    let carry = Buffer.alloc(0);
    while (end > 0) {
      const start = Math.max(0, end - CHUNK_BYTES);
      const chunk = Buffer.alloc(end - start);
      readSync(fd, chunk, 0, chunk.length, start);
      const text = Buffer.concat([chunk, carry]).toString('utf8');
      const lines = text.split('\n');
      // The first line may be cut by this chunk's start; keep it for the next.
      carry = start === 0 ? Buffer.alloc(0) : Buffer.from(lines.shift() ?? '');
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const state = readCostStateLine(lines[index] ?? '', sessionId);
        if (state !== null) {
          return state;
        }
      }
      end = start;
    }
    const first = readCostStateLine(carry.toString('utf8'), sessionId);
    return first;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Nothing to retry; the process drops the handle on exit.
      }
    }
  }
}

function readCostStateLine(
  line: string,
  sessionId: string,
): ClaudeCostState | null {
  if (!line.includes(CLAUDE_COST_STATE_LINE_TYPE)) {
    return null;
  }
  try {
    const record = asRecord(JSON.parse(line));
    if (
      asString(record?.type) !== CLAUDE_COST_STATE_LINE_TYPE ||
      asString(record?.sessionId) !== sessionId
    ) {
      return null;
    }
    return {
      costUsd: asNumber(record?.totalCostUSD),
      apiMs: asNumber(record?.totalAPIDuration),
    };
  } catch {
    return null;
  }
}
