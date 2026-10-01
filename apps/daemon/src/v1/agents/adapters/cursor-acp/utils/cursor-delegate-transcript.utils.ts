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
 * How much of an ENDED transcript's end is read for the delegate's report. A
 * reviewer's report measured ~4KB; the room is for a long one, and a report
 * longer than this simply reads as none — the wake prompt names the file.
 */
const REPORT_TAIL_BYTES = 262_144;

/**
 * How much of a transcript's end is read to find its LATEST user message,
 * which is where a RESUMED delegate's brief lands (see
 * {@link locateCursorDelegateTranscript}). The brief is a few KB and is
 * followed by everything the delegate has done since, so the room is for that.
 */
const RESUME_TAIL_BYTES = 1_048_576;

/**
 * How long after a launch the RESUMED rule may be tried. A new delegate's
 * transcript is born ~6s after its launch (measured), so before this the
 * absence of a new file says nothing, and an older conversation that merely
 * QUOTES the brief must not win the race against the delegate's own file.
 */
const RESUME_MIN_AGE_MS = 15_000;

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
    const tail = await readTail(path, TAIL_BYTES);
    if (tail === null) {
      continue;
    }
    const ending = endingFromTail(tail);
    if (ending.state !== 'ended') {
      return ending;
    }
    // Only an ENDED record is read further back, once: the report is the last
    // assistant line before `turn_ended`, and it can be far longer than the
    // window that decides whether there is one.
    const report = await readTail(path, REPORT_TAIL_BYTES);
    return {
      ...ending,
      finalText: report === null ? null : lastAssistantText(report),
      recordPath: path,
    };
  }
  return null;
}

/**
 * The text of the LAST assistant line in a transcript tail — the delegate's
 * report — or null. Lines that do not parse are skipped, which is what makes
 * a tail cut mid-line safe: the cut line is the oldest and never the last.
 */
export function lastAssistantText(tail: string): string | null {
  const lines = tail.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const record = parseLine(lines[index]!);
    if (record === null || asString(record.role) !== 'assistant') {
      continue;
    }
    const text = textOf(record);
    if (text !== null) {
      return text;
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
 *
 * A RESUMED delegate is the other shape, and only when no new transcript
 * matches. cursor's `Task` can continue a delegate that already exists, and
 * then writes no new file: the new brief is APPENDED to the old transcript as
 * a further user message. MEASURED on run `bd1e43ae` (2026.09.10-fd3934a):
 * seven reviewers cut off by a dropped stream were resumed at 17:04 into
 * transcripts born at 16:55–16:56 that open with their ORIGINAL briefs, each
 * now holding a second `<user_query>` with the new one. Matched on the first
 * rule alone, none was ever found, and all seven were closed — or left open —
 * as though nothing could watch them. So a transcript born BEFORE the launch
 * is still this delegate's when it was written to since the launch and its
 * LATEST user message carries the brief.
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
  const since = query.launchedAtMs - LAUNCH_SLACK_MS;
  let best: { id: string; bornAt: number } | null = null;
  const older: { id: string; path: string; modifiedAt: number }[] = [];
  for (const candidate of candidates) {
    // The parent's own conversation is never one of its delegates, however
    // closely its latest message quotes the brief it handed one.
    if (candidate.id === query.sessionId) {
      continue;
    }
    const times = await fileTimes(candidate.path);
    if (times === null) {
      continue;
    }
    if (times.bornAt < since) {
      // Untouched since the launch: it cannot hold this delegate's brief.
      if (times.modifiedAt >= since) {
        older.push({ ...candidate, modifiedAt: times.modifiedAt });
      }
      continue;
    }
    if (query.claimed.has(candidate.id)) {
      continue;
    }
    if (best !== null && times.bornAt >= best.bornAt) {
      continue;
    }
    const opening = firstUserText(await readHead(candidate.path));
    if (opening !== null && opening.includes(brief)) {
      best = { id: candidate.id, bornAt: times.bornAt };
    }
  }
  if (best !== null) {
    return best.id;
  }
  if (Date.now() - query.launchedAtMs < RESUME_MIN_AGE_MS) {
    return null;
  }
  // Oldest write first, the same launch-order reading the rule above takes.
  older.sort((a, b) => a.modifiedAt - b.modifiedAt);
  for (const candidate of older) {
    const tail = await readTail(candidate.path, RESUME_TAIL_BYTES);
    const latest = tail === null ? null : lastUserText(tail);
    if (latest === null || !latest.includes(brief)) {
      continue;
    }
    // Claimed by a delegate still out: handed over only when the brief written
    // LAST is not that delegate's own — it was cut off and is being continued.
    const claimant = query.claimed.get(candidate.id);
    if (claimant !== undefined && latest.includes(claimant.trim())) {
      continue;
    }
    return candidate.id;
  }
  return null;
}

/** The text of a transcript tail's LAST user message, or null. */
export function lastUserText(tail: string): string | null {
  const lines = tail.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const record = parseLine(lines[index]!);
    if (record !== null && asString(record.role) === 'user') {
      return textOf(record);
    }
  }
  return null;
}

/** The text of a transcript's opening user message, or null. */
export function firstUserText(head: string | null): string | null {
  if (head === null) {
    return null;
  }
  const newline = head.indexOf('\n');
  const record = parseLine(newline === -1 ? head : head.slice(0, newline));
  if (record === null || asString(record.role) !== 'user') {
    return null;
  }
  return textOf(record);
}

function parseLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (trimmed === '') {
    return null;
  }
  try {
    return asRecord(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

/** The text blocks of one transcript line's message, joined, or null. */
function textOf(record: Record<string, unknown>): string | null {
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

async function fileTimes(
  path: string,
): Promise<{ bornAt: number; modifiedAt: number } | null> {
  try {
    const info = await stat(path);
    return {
      // `birthtime` is real on macOS; where a filesystem cannot report one it
      // reads as the epoch, and the change time is the nearest honest stand-in.
      bornAt: info.birthtimeMs > 0 ? info.birthtimeMs : info.ctimeMs,
      modifiedAt: info.mtimeMs,
    };
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

/** The last `bytes` of a file, or null when it cannot be read. */
async function readTail(path: string, bytes: number): Promise<string | null> {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch {
    return null;
  }
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => {});
  }
}
