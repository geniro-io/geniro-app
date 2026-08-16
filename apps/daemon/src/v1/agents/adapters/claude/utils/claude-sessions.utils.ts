import { open, readdir, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  AgentEvent,
  AgentSessionHistory,
  AgentSessionRecord,
} from '../../adapter.types';
import {
  CLAUDE_SESSION_FILE_SUFFIX,
  CLAUDE_SESSION_HEAD_BUDGET_BYTES,
  CLAUDE_SESSION_TITLE_MAX_CHARS,
  CLAUDE_SESSIONS_DIR_NAME,
} from '../claude.const';
import { mapClaudeMessage } from './claude-message.utils';

/**
 * Reading the conversations this CLI has already held, off its own profile.
 *
 * The whole store is `<configDir>/projects/<cwd-with-slashes-flattened>/<sessionId>.jsonl`
 * — one append-only JSONL per session, in exactly the envelope
 * `-p --output-format stream-json` writes to stdout. That is the fact this file
 * rests on and the reason claude needs no protocol call to be imported: the
 * transcript is already in the vocabulary {@link mapClaudeMessage} speaks, so an
 * imported thread is built by the same mapper as a live one rather than by a
 * second reader that could disagree with it about what a row means.
 *
 * The directory NAME is deliberately never parsed. It is the cwd with its
 * separators flattened to `-`, which is lossy (`/a/b-c` and `/a-b/c` collide)
 * and undocumented; every `cwd` here is read from the file's own lines, where
 * the CLI writes it verbatim on each one.
 *
 * Scale is the other constraint. The author's own profile holds 2,448 sessions
 * over 1.7GB, and one session runs to 11MB — so nothing here reads a whole file
 * to answer "what is this about": the listing stats every candidate (cheap) and
 * opens only as far as the first user message, bounded by
 * {@link CLAUDE_SESSION_HEAD_BUDGET_BYTES}.
 */

/**
 * Resolved paths, so one folder is compared once however many sessions name it.
 *
 * MODULE-scope on purpose. The map is keyed by the path itself, so it is
 * correct across calls — and the paths a listing asks about are the same
 * handful every time, which is what makes the filter cost one `realpath` per
 * folder for the life of the daemon rather than one per listing.
 */
const canonicalPaths = new Map<string, string>();

/**
 * The path with its symlinks resolved, or the path itself when it cannot be.
 *
 * This exists because of a spelling, and it is the difference between the
 * folder filter working and silently matching nothing on macOS: the CLI writes
 * `cwd` as the process saw it, and this app canonicalizes every folder it
 * holds. Measured here — a session recorded
 * `/private/var/folders/…/geniro-run-cwd` while the composer held
 * `/var/folders/…/geniro-run-cwd`, the same directory through the `/var`
 * symlink, so a string compare rejected every session in the folder the user
 * was sitting in.
 *
 * A path that no longer exists resolves to ITSELF rather than being dropped: a
 * session whose folder has since been deleted is still a session, and it
 * compares equal to another spelling of the same missing path.
 */
async function canonical(path: string | null): Promise<string | null> {
  if (path === null || path === '') {
    return null;
  }
  const cached = canonicalPaths.get(path);
  if (cached !== undefined) {
    return cached;
  }
  let resolved = path;
  try {
    resolved = await realpath(path);
  } catch {
    // Deleted, or unreadable — the raw path is the best answer there is.
  }
  canonicalPaths.set(path, resolved);
  return resolved;
}

/** One `<configDir>/projects/<dir>/<id>.jsonl`, with what `stat` alone knows. */
interface SessionFile {
  id: string;
  path: string;
  dir: string;
  updatedAt: number;
}

/** What one file's opening lines say about itself. */
interface SessionHead {
  cwd: string | null;
  /** First real user message, already trimmed to a single line. */
  title: string | null;
}

/**
 * List the sessions in one profile, newest first.
 *
 * `cwd` filtering is done against the value read from the FILES, not from the
 * directory name — but a directory holds one folder's sessions, so the first
 * file identifies the rest and the remaining files in a rejected directory are
 * skipped without being opened. That is what keeps a filtered listing over
 * thousands of sessions to a few hundred small reads.
 */
export async function listClaudeSessions(input: {
  profileDir: string;
  cwd: string | null;
  limit: number;
}): Promise<AgentSessionRecord[]> {
  const files = await collectSessionFiles(input.profileDir);
  files.sort((a, b) => b.updatedAt - a.updatedAt);

  const wanted = input.cwd === null ? null : await canonical(input.cwd);
  const rows: AgentSessionRecord[] = [];
  /** Folder per project directory, learned from its first readable file. */
  const dirCwd = new Map<string, string | null>();
  for (const file of files) {
    if (rows.length >= input.limit) {
      break;
    }
    if (wanted !== null && dirCwd.get(file.dir) === null) {
      // Already established that this directory is some other folder's.
      continue;
    }
    const head = await readSessionHead(file.path);
    if (head === null) {
      continue;
    }
    if (wanted !== null && (await canonical(head.cwd)) !== wanted) {
      // Only mark the directory rejected on a file that actually stated a
      // folder — a line-less file says nothing about its neighbours.
      if (head.cwd !== null) {
        dirCwd.set(file.dir, null);
      }
      continue;
    }
    if (head.title === null) {
      // No user message in the file's opening budget: a session with nothing
      // said in it is not one anybody meant to carry on. Skipped rather than
      // listed under its id, which would offer the user a row that means
      // nothing and resumes nothing.
      continue;
    }
    dirCwd.set(file.dir, head.cwd);
    rows.push({
      id: file.id,
      cwd: head.cwd,
      title: head.title,
      updatedAt: file.updatedAt,
    });
  }
  return rows;
}

/**
 * The conversation itself, mapped through the live turn's own mapper.
 *
 * `limit` keeps the NEWEST events: an 11MB session is tens of thousands of
 * rows, and a thread that takes a minute to open is its own defect. What was
 * cut is reported rather than silently absent — see
 * {@link AgentSessionHistory.droppedBefore}.
 */
export async function readClaudeSessionHistory(input: {
  profileDir: string;
  sessionId: string;
  limit: number;
}): Promise<AgentSessionHistory | null> {
  const path = await findSessionFile(input.profileDir, input.sessionId);
  if (path === null) {
    return null;
  }
  const events: AgentEvent[] = [];
  let dropped = 0;
  await eachJsonLine(path, null, (line) => {
    for (const event of mapHistoryLine(line)) {
      events.push(event);
    }
    // Trimmed as we go rather than at the end: the point of the cap is to bound
    // what is HELD, and a 60k-event array built first would defeat it.
    while (events.length > input.limit) {
      events.shift();
      dropped += 1;
    }
    return true;
  });
  return { events, droppedBefore: dropped };
}

/**
 * The events one stored line becomes.
 *
 * Only the two line types that carry the conversation are offered to the
 * mapper. The rest of what the CLI appends to a session is either its own
 * bookkeeping (`queue-operation`, `last-prompt`, `file-history-snapshot`) or
 * belongs to a turn that is over (`result`, whose cost and duration describe a
 * turn geniro did not run and must not attribute to one it did).
 *
 * `isSidechain` lines are a sub-agent's own conversation. They are dropped
 * here, and that is a decision rather than an omission: a delegate's rows join
 * the transcript through `parentToolUseId`, which stitches them under the tool
 * call that launched them — a call whose own row may be thousands of lines and
 * one `limit` trim away. Imported alone they would render as orphans in the
 * main thread.
 */
function mapHistoryLine(line: Record<string, unknown>): AgentEvent[] {
  if (line.isSidechain === true) {
    return [];
  }
  const type = line.type;
  if (type === 'assistant') {
    return mapClaudeMessage(line);
  }
  if (type !== 'user') {
    return [];
  }
  // A user line carries BOTH halves of the turn boundary: the person's own
  // text, and the tool results the CLI attributes to them. The mapper knows the
  // second (it is the same line a live turn sees) and cannot know the first,
  // because in a live turn the daemon wrote it. So the text is read here and
  // the rest is left to the mapper — never both, or a line holding text and a
  // tool result would be read twice.
  const text = userText(line);
  return text === null
    ? mapClaudeMessage(line)
    : [{ type: 'user_message', text }];
}

/**
 * Envelopes the CLI wraps around things that are not the user speaking: the
 * plumbing of a slash command (`<command-name>`, `<command-message>`,
 * `<command-args>`), the output it splices back in (`<local-command-stdout>`,
 * `<local-command-caveat>`), and the context blocks it injects
 * (`<system-reminder>`). All observed in this profile's own files.
 */
const ENVELOPE_BLOCK =
  /<(command-[a-z-]+|local-command-[a-z-]+|system-reminder)>([\s\S]*?)<\/\1>/g;
/** The slash command itself, which IS what the user typed. */
const COMMAND_NAME = /<command-name>([\s\S]*?)<\/command-name>/;
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;

/**
 * The person's own words on a `user` line, or null when the line is something
 * else wearing the user role.
 *
 * Four things are NOT the user talking, and each was observed in this profile's
 * own files: a synthetic line the CLI injects after a compaction, a replayed
 * line it re-appends with `isReplay`, a line whose content is entirely
 * `tool_result` blocks, and a line that is only envelopes.
 *
 * A slash command is the interesting case, and it is neither kept whole nor
 * dropped. Whole, it reads as three lines of XML where the transcript wants one
 * line; dropped, a session whose every turn is `/geniro:implement …` becomes an
 * unnamed row in the picker and a transcript of answers to nothing. So the
 * envelopes are stripped and the command is reconstituted as the user typed it.
 */
function userText(line: Record<string, unknown>): string | null {
  if (line.isSynthetic === true || line.isReplay === true) {
    return null;
  }
  const message = line.message;
  if (typeof message !== 'object' || message === null) {
    return null;
  }
  const content = (message as Record<string, unknown>).content;
  const raw =
    typeof content === 'string' ? content : joinTextBlocks(content).trim();
  if (raw === '') {
    return null;
  }
  const spoken = raw.replace(ENVELOPE_BLOCK, '').trim();
  if (spoken !== '') {
    return spoken;
  }
  const name = COMMAND_NAME.exec(raw)?.[1]?.trim();
  if (name === undefined || name === '') {
    return null;
  }
  const args = COMMAND_ARGS.exec(raw)?.[1]?.trim();
  return args ? `${name} ${args}` : name;
}

function joinTextBlocks(content: unknown): string {
  if (!Array.isArray(content)) {
    return '';
  }
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) {
      continue;
    }
    const record = block as Record<string, unknown>;
    if (record.type === 'text' && typeof record.text === 'string') {
      parts.push(record.text);
    }
  }
  return parts.join('\n');
}

/** Every session file under `<profileDir>/projects`, with its mtime. */
async function collectSessionFiles(profileDir: string): Promise<SessionFile[]> {
  const root = join(profileDir, CLAUDE_SESSIONS_DIR_NAME);
  let dirs: string[];
  try {
    dirs = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    // No profile, or no conversations in it yet.
    return [];
  }
  const files: SessionFile[] = [];
  for (const dir of dirs) {
    const dirPath = join(root, dir);
    let names: string[];
    try {
      names = await readdir(dirPath);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(CLAUDE_SESSION_FILE_SUFFIX)) {
        continue;
      }
      const path = join(dirPath, name);
      try {
        const info = await stat(path);
        if (!info.isFile()) {
          continue;
        }
        files.push({
          id: name.slice(0, -CLAUDE_SESSION_FILE_SUFFIX.length),
          path,
          dir,
          updatedAt: Math.round(info.mtimeMs),
        });
      } catch {
        // Vanished between readdir and stat.
      }
    }
  }
  return files;
}

/** Where one session id lives, or null when this profile does not hold it. */
async function findSessionFile(
  profileDir: string,
  sessionId: string,
): Promise<string | null> {
  const files = await collectSessionFiles(profileDir);
  return files.find((file) => file.id === sessionId)?.path ?? null;
}

/**
 * Read a file's opening lines for its folder and its first user message,
 * stopping as soon as both are known.
 *
 * The budget is what makes a 2,448-session listing affordable. It is not a
 * guess about line count: a session's first lines routinely include hook output
 * and a system-reminder block running to tens of kilobytes, so the budget is
 * set in BYTES and a file whose first user message sits past it is treated as
 * having none.
 */
async function readSessionHead(path: string): Promise<SessionHead | null> {
  const head: SessionHead = { cwd: null, title: null };
  const read = await eachJsonLine(
    path,
    CLAUDE_SESSION_HEAD_BUDGET_BYTES,
    (line) => {
      if (
        head.cwd === null &&
        typeof line.cwd === 'string' &&
        line.cwd !== ''
      ) {
        head.cwd = line.cwd;
      }
      if (head.title === null && line.type === 'user') {
        const text = userText(line);
        if (text !== null) {
          head.title = toTitle(text);
        }
      }
      return head.cwd === null || head.title === null;
    },
  );
  return read ? head : null;
}

/** One line of a multi-line prompt, short enough for a picker row. */
function toTitle(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > CLAUDE_SESSION_TITLE_MAX_CHARS
    ? `${line.slice(0, CLAUDE_SESSION_TITLE_MAX_CHARS - 1).trimEnd()}…`
    : line;
}

/**
 * Feed each parseable JSON line of a file to `onLine`, stopping when it returns
 * false or `budgetBytes` is spent.
 *
 * Chunked by hand rather than through `readline` so the budget is enforced on
 * BYTES READ — the thing that actually costs — and so a file with no newline in
 * it cannot buffer 11MB while waiting for one. Returns false only when the file
 * could not be opened: an unparseable line is skipped, because one truncated
 * append (a session the CLI was writing when the machine slept) must not cost
 * the whole transcript.
 */
async function eachJsonLine(
  path: string,
  budgetBytes: number | null,
  onLine: (line: Record<string, unknown>) => boolean,
): Promise<boolean> {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch {
    return false;
  }
  try {
    const chunk = Buffer.alloc(64 * 1024);
    let rest = '';
    let read = 0;
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) {
        break;
      }
      read += bytesRead;
      rest += chunk.subarray(0, bytesRead).toString('utf8');
      let cut = rest.indexOf('\n');
      while (cut >= 0) {
        const line = rest.slice(0, cut);
        rest = rest.slice(cut + 1);
        if (line.trim() !== '' && !feed(line, onLine)) {
          return true;
        }
        cut = rest.indexOf('\n');
      }
      if (budgetBytes !== null && read >= budgetBytes) {
        break;
      }
    }
    // The last line of a file the CLI is still appending to has no newline yet.
    if (rest.trim() !== '') {
      feed(rest, onLine);
    }
    return true;
  } finally {
    await handle.close();
  }
}

function feed(
  line: string,
  onLine: (line: Record<string, unknown>) => boolean,
): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return true;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return true;
  }
  return onLine(parsed as Record<string, unknown>);
}
