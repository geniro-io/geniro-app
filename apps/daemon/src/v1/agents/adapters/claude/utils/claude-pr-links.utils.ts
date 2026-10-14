import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';

import { asNumber, asRecord, asString } from '../../../utils/json-util';
import { readPullRequestUrls } from '../../../utils/pull-request-capture';
import type { SessionPullRequest } from '../../adapter.types';
import { CLAUDE_PR_LINK_LINE_TYPE } from '../claude.const';
import { findSessionFile } from './claude-sessions.utils';

/**
 * How many sessions' answers are remembered. The capture asks on every turn
 * end and every listing of a run with new rows, about EVERY conversation the
 * run held, and only the one in use has changed — a re-read is a full pass
 * over a file of megabytes plus a stat in every project directory to find it.
 */
const MAX_REMEMBERED_SESSIONS = 2_000;

interface Remembered {
  path: string;
  size: number;
  mtimeMs: number;
  records: SessionPullRequest[];
}

const remembered = new Map<string, Remembered>();

/**
 * The pull requests one session's transcript records as touched, oldest first,
 * repeats included (the caller dedupes); empty when the profile holds no such
 * session or its file cannot be read. A file whose size and modification time
 * are what they were at the last read is answered from that read.
 *
 * Only lines naming THIS session count: a forked session's file starts with a
 * copy of its parent's lines, and those pull requests are the parent's. Every
 * line is tested for the type's text before it is parsed, since a session file
 * runs to megabytes and holds a handful of these.
 */
export async function readClaudeSessionPullRequests(
  profileDir: string,
  sessionId: string,
): Promise<SessionPullRequest[]> {
  const key = `${profileDir}\u0000${sessionId}`;
  const known = remembered.get(key);
  let path = known?.path ?? null;
  let now = path === null ? null : await statOf(path);
  if (now === null) {
    path = await findSessionFile(profileDir, sessionId);
    now = path === null ? null : await statOf(path);
  }
  if (path === null || now === null) {
    remembered.delete(key);
    return [];
  }
  if (
    known !== undefined &&
    known.path === path &&
    known.size === now.size &&
    known.mtimeMs === now.mtimeMs
  ) {
    // Re-inserted so the bound below drops the least recently ASKED session.
    remembered.delete(key);
    remembered.set(key, known);
    return [...known.records];
  }
  const { records, complete } = await readRecords(path, sessionId);
  remembered.delete(key);
  if (!complete) {
    // A read that failed part-way answers what it got, and is not remembered:
    // a permission change moves no mtime, so it would stand until the next write.
    return records;
  }
  remembered.set(key, { path, ...now, records });
  if (remembered.size > MAX_REMEMBERED_SESSIONS) {
    const oldest = remembered.keys().next().value;
    if (oldest !== undefined) {
      remembered.delete(oldest);
    }
  }
  return [...records];
}

async function statOf(
  path: string,
): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const { size, mtimeMs } = await stat(path);
    return { size, mtimeMs };
  } catch {
    return null;
  }
}

async function readRecords(
  path: string,
  sessionId: string,
): Promise<{ records: SessionPullRequest[]; complete: boolean }> {
  const found: SessionPullRequest[] = [];
  const marker = `"${CLAUDE_PR_LINK_LINE_TYPE}"`;
  try {
    const lines = createInterface({
      input: createReadStream(path, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    for await (const line of lines) {
      if (!line.includes(marker)) {
        continue;
      }
      const pullRequest = readPrLinkLine(line, sessionId);
      if (pullRequest !== null) {
        found.push(pullRequest);
      }
    }
  } catch {
    // A file cut off or removed mid-read keeps what was read before it.
    return { records: found, complete: false };
  }
  return { records: found, complete: true };
}

function readPrLinkLine(
  line: string,
  sessionId: string,
): SessionPullRequest | null {
  let record: Record<string, unknown> | null;
  try {
    record = asRecord(JSON.parse(line));
  } catch {
    return null;
  }
  if (
    asString(record?.type) !== CLAUDE_PR_LINK_LINE_TYPE ||
    asString(record?.sessionId) !== sessionId
  ) {
    return null;
  }
  // The URL is the identity, read by the transcript capture's own github.com
  // rule; a record whose number disagrees with it is not trusted either way.
  const [pullRequest] = readPullRequestUrls(asString(record?.prUrl) ?? '');
  if (
    pullRequest === undefined ||
    pullRequest.number !== asNumber(record?.prNumber)
  ) {
    return null;
  }
  const at = new Date(asString(record?.timestamp) ?? '');
  return { ...pullRequest, at: Number.isNaN(at.getTime()) ? null : at };
}
