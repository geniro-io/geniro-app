import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { asRecord, asString } from '../../../utils/json-util';
import type {
  AcpDelegateEnding,
  AcpDelegateQuery,
  AcpDelegateRef,
} from '../../acp/acp-driver';
import {
  CURSOR_AGENT_TRANSCRIPTS_DIR,
  CURSOR_PROJECTS_DIR_NAME,
  CURSOR_SUBAGENT_TRANSCRIPTS_DIR,
  CURSOR_TRANSCRIPT_OUTCOMES,
  CURSOR_TRANSCRIPT_TURN_ENDED,
} from '../cursor-acp.const';

/**
 * Reading how a background delegate of cursor-agent ENDED, off the transcript
 * the CLI writes for it — the one place that ending is recorded. See the
 * `Background sub-agents` block in `cursor-acp.const.ts` for where the file
 * lives, what closes it, and what was measured.
 *
 * Read-only, and defensive throughout: the directory is the CLI's, not ours,
 * and a file this cannot find or read answers null ("cannot tell"), never an
 * ending it did not see.
 */

/**
 * How much of the file's END is read. The closing line is ~40 bytes; the room
 * is for the last assistant line before it, which can be long, so a file still
 * being written is judged on a complete line rather than on a fragment.
 */
const TAIL_BYTES = 8_192;

/**
 * How far BEFORE its launch a delegate's transcript may appear to have been
 * created. The launch time is taken when the launching call returns, which is
 * after the CLI has already started the delegate — measured: the transcript
 * directory is born ~6s AFTER that moment — so this only absorbs clock and
 * filesystem-timestamp granularity, never a genuinely older conversation.
 */
const LAUNCH_SLACK_MS = 10_000;

/**
 * How much of a transcript's HEAD is read to find its first line, which holds
 * the delegate's whole brief. A reviewer brief runs to a few KB; the cap only
 * bounds a pathological file.
 */
const HEAD_BYTES_MAX = 1_048_576;

/**
 * The delegate's state as its own transcript states it, or null when no
 * transcript could be found or read.
 *
 * `cursorHome` is the CLI's home directory (`~/.cursor`), passed in so the
 * adapter's own home seam reaches this read too.
 */
export async function readCursorDelegateEnding(
  ref: AcpDelegateRef,
  cursorHome: string,
): Promise<AcpDelegateEnding | null> {
  const transcripts = transcriptsDir(cursorHome, ref.cwd);
  const file = `${ref.conversationId}.jsonl`;
  const candidates = [join(transcripts, ref.conversationId, file)];
  if (ref.sessionId !== null) {
    candidates.push(
      join(transcripts, ref.sessionId, CURSOR_SUBAGENT_TRANSCRIPTS_DIR, file),
    );
  }
  for (const path of candidates) {
    const tail = await readTail(path);
    if (tail !== null) {
      return endingFromTail(tail);
    }
  }
  return null;
}

/**
 * The conversation id of the transcript a NEW delegate was given, matched by
 * its brief — or null when none matches yet.
 *
 * Needed because nothing on the wire names it. `cursor/task` does carry an
 * `agentId`, but it is not the transcript's name — MEASURED 2026-09-30
 * through this daemon: a delegate announced with `agentId: 05df2846-…` wrote
 * its transcript as `00f805d1-…`, and no file anywhere under `~/.cursor` was
 * named after the `agentId`. What does match is the BRIEF: each transcript
 * opens with a user message wrapping it verbatim —
 * `<user_query>\n{prompt}\n</user_query>` — in a directory born a few seconds
 * after the launch.
 *
 * A candidate must be born after the launch, not already claimed by another
 * delegate, and open with this brief; the OLDEST such is taken, so two
 * delegates given the same brief are matched in launch order.
 */
export async function locateCursorDelegateTranscript(
  query: AcpDelegateQuery,
  cursorHome: string,
): Promise<string | null> {
  const transcripts = transcriptsDir(cursorHome, query.cwd);
  const candidates: { id: string; path: string }[] = [];
  for (const entry of await listDir(transcripts)) {
    if (entry.isDirectory()) {
      candidates.push({
        id: entry.name,
        path: join(transcripts, entry.name, `${entry.name}.jsonl`),
      });
    }
  }
  if (query.sessionId !== null) {
    const nested = join(
      transcripts,
      query.sessionId,
      CURSOR_SUBAGENT_TRANSCRIPTS_DIR,
    );
    for (const entry of await listDir(nested)) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        candidates.push({
          id: entry.name.slice(0, -'.jsonl'.length),
          path: join(nested, entry.name),
        });
      }
    }
  }
  const brief = query.prompt.trim();
  let best: { id: string; bornAt: number } | null = null;
  for (const candidate of candidates) {
    if (query.claimed.has(candidate.id)) {
      continue;
    }
    const bornAt = await bornAtMs(candidate.path);
    if (bornAt === null || bornAt < query.launchedAtMs - LAUNCH_SLACK_MS) {
      continue;
    }
    if (best !== null && bornAt >= best.bornAt) {
      continue;
    }
    const opening = firstUserText(await readHead(candidate.path));
    if (opening !== null && opening.includes(brief)) {
      best = { id: candidate.id, bornAt };
    }
  }
  return best?.id ?? null;
}

/** The text of a transcript's opening user message, or null. */
export function firstUserText(head: string | null): string | null {
  if (head === null) {
    return null;
  }
  const newline = head.indexOf('\n');
  let parsed: unknown;
  try {
    parsed = JSON.parse(newline === -1 ? head : head.slice(0, newline));
  } catch {
    return null;
  }
  const record = asRecord(parsed);
  if (record === null || asString(record.role) !== 'user') {
    return null;
  }
  const content = asRecord(record.message)?.content;
  if (!Array.isArray(content)) {
    return null;
  }
  const texts = content
    .map((block) => asString(asRecord(block)?.text))
    .filter((text): text is string => text !== null);
  return texts.length === 0 ? null : texts.join('\n');
}

function transcriptsDir(cursorHome: string, cwd: string): string {
  return join(
    cursorHome,
    CURSOR_PROJECTS_DIR_NAME,
    cursorProjectKey(cwd),
    CURSOR_AGENT_TRANSCRIPTS_DIR,
  );
}

/**
 * The directory name the CLI files a workspace's state under — its own
 * `workspace-paths` rule, transcribed: every non-alphanumeric becomes `-`, runs
 * collapse, and the ends are trimmed. `/Users/me/Projects/App` →
 * `Users-me-Projects-App`.
 */
export function cursorProjectKey(workspacePath: string): string {
  return workspacePath
    .replace(/[^a-zA-Z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * What the transcript's LAST line says. Only the last one decides: the CLI
 * writes `turn_ended` as its final act, so any other last line — or one still
 * half-written, which does not parse — means the delegate is working.
 */
export function endingFromTail(tail: string): AcpDelegateEnding {
  const last = tail
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .pop();
  if (last === undefined) {
    return { state: 'running' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(last);
  } catch {
    return { state: 'running' };
  }
  const record = asRecord(parsed);
  if (
    record === null ||
    asString(record.type) !== CURSOR_TRANSCRIPT_TURN_ENDED
  ) {
    return { state: 'running' };
  }
  const status = asString(record.status);
  return {
    state: 'ended',
    outcome:
      status === null ? null : (CURSOR_TRANSCRIPT_OUTCOMES.get(status) ?? null),
  };
}

async function listDir(path: string) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function bornAtMs(path: string): Promise<number | null> {
  try {
    const info = await stat(path);
    // `birthtime` is real on macOS; where a filesystem cannot report one it
    // reads as the epoch, and the change time is the nearest honest stand-in.
    return info.birthtimeMs > 0 ? info.birthtimeMs : info.ctimeMs;
  } catch {
    return null;
  }
}

/** The start of a file up to its first newline (or the cap), or null. */
async function readHead(path: string): Promise<string | null> {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch {
    return null;
  }
  try {
    const chunks: Buffer[] = [];
    let read = 0;
    for (;;) {
      const buffer = Buffer.alloc(16_384);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, read);
      if (bytesRead === 0) {
        break;
      }
      const chunk = buffer.subarray(0, bytesRead);
      chunks.push(chunk);
      read += bytesRead;
      if (chunk.includes(0x0a) || read >= HEAD_BYTES_MAX) {
        break;
      }
    }
    return Buffer.concat(chunks).toString('utf8');
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => {});
  }
}

/** The last {@link TAIL_BYTES} of a file, or null when it cannot be read. */
async function readTail(path: string): Promise<string | null> {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch {
    return null;
  }
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => {});
  }
}
