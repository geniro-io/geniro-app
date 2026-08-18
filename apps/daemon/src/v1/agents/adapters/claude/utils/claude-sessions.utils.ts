import { open, readdir, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { isPlainSessionId } from '../../../utils/session-id';
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
import { ClaudeSessionCostLedger } from './claude-usage.utils';

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

/**
 * How many session heads are opened at once.
 *
 * Eight because that is where the measured curve flattens on the real profile
 * (400 heads: 155ms sequential, 11ms at this width) and because each open head
 * is a file handle — the point of a batch rather than one `Promise.all` over
 * every file is that the second is unbounded in the size of the user's history.
 */
const HEAD_READ_BATCH = 8;

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
  // Heads are read a BATCH at a time and then decided over IN ORDER. Both
  // halves matter: reading them one await at a time cost 155ms of the 183ms a
  // real 563-session listing took, while deciding out of order would break the
  // newest-first result AND the `dirCwd` short-circuit, which depends on a
  // rejected directory being known before its remaining files are reached.
  //
  // The map is consulted TWICE, and the second time is not redundant. The read
  // inside the batch runs against the state as of the batch's START, so it can
  // only spare a read; the read in the decision loop below runs against the
  // state as of that row, which is what makes the ANSWER the same however the
  // boundary falls. Without it, a directory rejected mid-batch still admits the
  // rows behind it in that batch — and a project directory genuinely can hold
  // two folders' sessions, because the directory name is the cwd with its
  // separators flattened and that is lossy (`/a/b-c` and `/a-b/c` collide, as
  // the file's own doc block records). A matching session in such a directory
  // would then appear or vanish from the picker depending only on how many
  // unrelated sessions happened to sort ahead of it.
  //
  // Concurrency is bounded rather than unleashed over `files`: a profile of
  // this size would otherwise open thousands of file handles at once.
  for (
    let start = 0;
    start < files.length && rows.length < input.limit;
    start += HEAD_READ_BATCH
  ) {
    const batch = files.slice(start, start + HEAD_READ_BATCH);
    const probed = await Promise.all(
      batch.map(async (file) => {
        if (wanted !== null && dirCwd.get(file.dir) === null) {
          // Already established that this directory is some other folder's.
          return null;
        }
        const head = await readSessionHead(file.path);
        if (head === null) {
          return null;
        }
        return {
          head,
          cwd: wanted === null ? null : await canonical(head.cwd),
        };
      }),
    );
    for (const [index, file] of batch.entries()) {
      if (rows.length >= input.limit) {
        break;
      }
      if (wanted !== null && dirCwd.get(file.dir) === null) {
        // Re-read, against the state as of THIS row: an earlier row in this
        // same batch may have rejected the directory after the batch's own
        // check had already let this one through.
        continue;
      }
      const found = probed[index];
      if (found === undefined || found === null) {
        continue;
      }
      const { head } = found;
      if (wanted !== null && found.cwd !== wanted) {
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
  // Inert by construction, and threaded only because the mapper's signature
  // requires one: the sole line type carrying session cost totals is `result`,
  // which `mapHistoryLine` drops before the mapper ever sees it (see its doc
  // block). Scoped to this import so it cannot outlive the file being read.
  const costLedger = new ClaudeSessionCostLedger();
  await eachJsonLine(path, null, (line) => {
    for (const event of mapHistoryLine(line, costLedger)) {
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
function mapHistoryLine(
  line: Record<string, unknown>,
  costLedger: ClaudeSessionCostLedger,
): AgentEvent[] {
  if (line.isSidechain === true) {
    return [];
  }
  const type = line.type;
  if (type === 'assistant') {
    return mapClaudeMessage(line, costLedger);
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
    ? mapClaudeMessage(line, costLedger)
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
  // Concurrent rather than one await at a time: these are independent round
  // trips to the same disk with nothing between them, and awaiting each in turn
  // made the cost linear in the profile's SIZE — measured on a real profile
  // (380 directories, 563 sessions) the sequential scan took 28ms warm against
  // 5ms this way, and the picker pays it on every open, the listing being
  // deliberately uncached beyond its in-flight join.
  //
  // BOUNDED, at the same width the head reads use, and for the same reason: a
  // `Promise.all` over `dirs` opens one `readdir` per project directory and
  // then one `stat` per file inside it, so on the author's own profile (2,448
  // sessions) the unbounded form has thousands of descriptors outstanding at
  // once. Bounding the outer loop bounds the inner one with it, since each
  // directory's stats only run while that directory holds a slot.
  const perDir: SessionFile[][] = [];
  for (let start = 0; start < dirs.length; start += HEAD_READ_BATCH) {
    perDir.push(
      ...(await Promise.all(
        dirs.slice(start, start + HEAD_READ_BATCH).map(async (dir) => {
          const dirPath = join(root, dir);
          let names: string[];
          try {
            names = await readdir(dirPath);
          } catch {
            return [];
          }
          const stats = await Promise.all(
            names
              .filter((name) => name.endsWith(CLAUDE_SESSION_FILE_SUFFIX))
              .map(async (name): Promise<SessionFile | null> => {
                const path = join(dirPath, name);
                try {
                  const info = await stat(path);
                  if (!info.isFile()) {
                    return null;
                  }
                  return {
                    id: name.slice(0, -CLAUDE_SESSION_FILE_SUFFIX.length),
                    path,
                    dir,
                    updatedAt: Math.round(info.mtimeMs),
                  };
                } catch {
                  // Vanished between readdir and stat.
                  return null;
                }
              }),
          );
          return stats.filter((file): file is SessionFile => file !== null);
        }),
      )),
    );
  }
  return perDir.flat();
}

/**
 * Where one session id lives, or null when this profile does not hold it.
 *
 * The id is a FILENAME, so the answer is one `stat` per project directory
 * rather than a full listing: the caller already knows which session it wants,
 * and re-scanning every file in the profile — plus mtime-ing each — to rediscover
 * a name it was handed is work with no result to show for it.
 *
 * The id therefore reaches a path, which the scan it replaced never let it do,
 * so a separator in it is refused rather than joined. It arrives over HTTP.
 */
async function findSessionFile(
  profileDir: string,
  sessionId: string,
): Promise<string | null> {
  if (!isPlainSessionId(sessionId)) {
    return null;
  }
  const name = `${sessionId}${CLAUDE_SESSION_FILE_SUFFIX}`;
  const root = join(profileDir, CLAUDE_SESSIONS_DIR_NAME);
  let dirs: string[];
  try {
    dirs = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return null;
  }
  const hits = await Promise.all(
    dirs.map(async (dir) => {
      const path = join(root, dir, name);
      try {
        return (await stat(path)).isFile() ? path : null;
      } catch {
        return null;
      }
    }),
  );
  return hits.find((path) => path !== null) ?? null;
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
    // Decoded ACROSS reads, never per read. A 64KB boundary falls wherever the
    // byte count lands, so it routinely lands INSIDE a multi-byte character —
    // and `Buffer.toString('utf8')` on a chunk ending mid-character yields
    // U+FFFD for it and drops the trailing bytes, so the next chunk starts on
    // the remainder and mangles that too. The damage is silent, because JSON's
    // own syntax is all ASCII: the line still parses, and the corruption lands
    // in the transcript as a replacement character in whatever the user or the
    // agent actually wrote. A session of the size this file is built for (11MB)
    // crosses ~170 of those boundaries. `StringDecoder` holds the partial bytes
    // back until the read that completes them.
    const decoder = new StringDecoder('utf8');
    let rest = '';
    let read = 0;
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) {
        break;
      }
      read += bytesRead;
      rest += decoder.write(chunk.subarray(0, bytesRead));
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
    // Whatever the decoder is still holding: bytes of a character the file (or
    // the byte budget) ended in the middle of. `end()` renders them as U+FFFD,
    // which is the honest reading of a genuinely truncated character — unlike
    // the per-chunk decode above, where the rest of the character was in the
    // very next read.
    rest += decoder.end();
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
