import {
  createWriteStream,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  type WriteStream,
} from 'node:fs';
import { join } from 'node:path';

import { Subject } from 'rxjs';

import {
  type DebugChannel,
  type DebugEntry,
  type DebugLevel,
  DEFAULT_DEBUG_CHANNELS,
} from '../diagnostics.types';
import { redactSecrets } from './redact';

/**
 * The daemon's debug log, as a MODULE-SCOPE singleton rather than a Nest
 * provider.
 *
 * It has to exist before Nest does. The pino logger is configured on the
 * bootstrapper in `main.ts`, several awaits ahead of the first injectable, and
 * the lines emitted in that window — the instance lock, the schema sync, the
 * stranded-child reap, every reconcile — are precisely the ones worth having
 * when a launch goes wrong. A DI-scoped sink would start recording after all
 * of them. `configureChildJournal` is the same shape for the same reason, and
 * this follows it deliberately.
 *
 * `DebugLogService` wraps this for injectable consumers; nothing else should
 * reach in here directly.
 */

/**
 * How many entries stay in memory for a reconnecting reader to catch up on.
 *
 * Sized for a reader who looked away, not for history — history is the FILE.
 * A turn under `agent-stdio` produces thousands of lines, so a ring big enough
 * to hold "everything since you opened the app" would be a memory leak with a
 * nicer name.
 */
const RING_CAPACITY = 2_000;

/** Past this, one line is truncated with a marker naming what was dropped. */
const MAX_MESSAGE_LENGTH = 8_000;

/** A log file is rotated once it passes this. */
const MAX_FILE_BYTES = 8 * 1024 * 1024;

/** How many rotated files are kept before the oldest is deleted. */
const MAX_FILES = 5;

const FILE_PREFIX = 'geniro-daemon';

interface SinkOptions {
  /** Directory the log files live in; absent = memory only, no file. */
  dir?: string | null;
  /** Overridable for tests, so a rotation can be provoked in-process. */
  maxFileBytes?: number;
  maxFiles?: number;
  /** Wall clock, injectable so a spec can produce deterministic names. */
  now?: () => Date;
}

class DebugSink {
  private readonly ring: DebugEntry[] = [];
  private readonly subject = new Subject<DebugEntry>();
  private channels = new Set<DebugChannel>(DEFAULT_DEBUG_CHANNELS);
  private seq = 0;
  /** Lowest seq still in the ring — the reader's "you missed some" signal. */
  private oldestSeq = 0;
  private dir: string | null = null;
  private stream: WriteStream | null = null;
  private streamPath: string | null = null;
  private written = 0;
  private maxFileBytes = MAX_FILE_BYTES;
  private maxFiles = MAX_FILES;
  private now: () => Date = () => new Date();
  /**
   * Set once a file write has failed. The sink NEVER throws at its callers —
   * it is called from inside the logger and from stream handlers, where an
   * exception would take down the thing being logged about — so a broken file
   * degrades to memory-only and says so once.
   */
  private fileError: string | null = null;

  /**
   * (Re)initialise the sink. Called ONCE per launch, from `main.ts`, before
   * anything can have read from it.
   *
   * It resets the ring and the seq counter, because "configure" here means
   * "this is a fresh daemon" — the seq is documented as monotonic *within one
   * launch*, and carrying a previous launch's numbering forward would break
   * that for the one reader (`afterSeq`) that depends on it. That is also what
   * makes the singleton testable: a spec configures it and starts from a known
   * empty state rather than from whatever the previous spec left behind.
   */
  configure(options: SinkOptions): void {
    this.maxFileBytes = options.maxFileBytes ?? MAX_FILE_BYTES;
    this.maxFiles = options.maxFiles ?? MAX_FILES;
    this.now = options.now ?? (() => new Date());
    this.dir = options.dir ?? null;
    this.ring.length = 0;
    this.seq = 0;
    this.oldestSeq = 0;
    this.closeStream();
    this.fileError = null;
    this.seedKnown();
    if (this.dir) {
      this.openStream();
    }
  }

  setChannels(channels: readonly DebugChannel[]): void {
    this.channels = new Set(channels);
  }

  enabledChannels(): DebugChannel[] {
    return [...this.channels];
  }

  isEnabled(channel: DebugChannel): boolean {
    return this.channels.has(channel);
  }

  filePath(): string | null {
    return this.streamPath;
  }

  lastSeq(): number {
    return this.seq;
  }

  /** Live entries, for the WS fan-out. */
  stream$(): Subject<DebugEntry> {
    return this.subject;
  }

  /**
   * Entries after `afterSeq`, plus how many were lost to the ring wrapping.
   *
   * `dropped` is derived from the ring's own oldest seq rather than counted as
   * entries fall out, because a reader that was away for a while needs the gap
   * relative to ITS cursor, which only it knows.
   */
  since(
    afterSeq: number,
    limit = RING_CAPACITY,
  ): { entries: DebugEntry[]; dropped: number } {
    const dropped =
      afterSeq + 1 < this.oldestSeq ? this.oldestSeq - (afterSeq + 1) : 0;
    const matching = this.ring.filter((entry) => entry.seq > afterSeq);
    // The TAIL when over the limit: a reader catching up wants the newest
    // lines, and dropping the newest to honour a limit would hand back a page
    // that never advances toward the present.
    const entries =
      matching.length > limit
        ? matching.slice(matching.length - limit)
        : matching;
    return { entries, dropped };
  }

  /**
   * Record one line. Never throws, and returns the entry only when the channel
   * is on — callers use that to skip building expensive payloads.
   */
  record(
    channel: DebugChannel,
    level: DebugLevel,
    message: string,
    context?: Record<string, string> | null,
  ): DebugEntry | null {
    if (!this.channels.has(channel)) {
      return null;
    }
    try {
      const entry: DebugEntry = {
        seq: this.seq++,
        at: this.now().toISOString(),
        channel,
        level,
        // Redaction happens HERE, at the one door every entry passes through,
        // rather than at each of the four sources. A source added later is
        // scrubbed without its author having to know that it must be.
        message: truncate(redactSecrets(message)),
        context: context ? redactContext(context) : null,
      };
      this.ring.push(entry);
      if (this.ring.length > RING_CAPACITY) {
        this.ring.shift();
        this.oldestSeq = this.ring[0]?.seq ?? entry.seq;
      }
      this.appendToFile(entry);
      this.subject.next(entry);
      return entry;
    } catch {
      // Logging must never be the thing that breaks a turn.
      return null;
    }
  }

  /** Close the file handle — the Nest shutdown hook's job. */
  close(): void {
    this.closeStream();
  }

  private appendToFile(entry: DebugEntry): void {
    if (!this.stream || this.fileError) {
      return;
    }
    const line = `${JSON.stringify(entry)}\n`;
    try {
      this.stream.write(line);
      this.written += Buffer.byteLength(line);
      if (this.written >= this.maxFileBytes) {
        this.rotate();
      }
    } catch (err) {
      this.fileError = err instanceof Error ? err.message : String(err);
    }
  }

  private openStream(): void {
    if (!this.dir) {
      return;
    }
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      // One file per LAUNCH, stamped. A single appended file would interleave
      // two runs of the app with no boundary, and "the log from the session
      // that broke" is the thing a reader is always actually after.
      const stamp = this.now().toISOString().replace(/[:.]/g, '-');
      const path = join(this.dir, `${FILE_PREFIX}-${stamp}.jsonl`);
      // 0600: the file holds the daemon's account of the user's own source
      // tree. `mode` applies at CREATION only, which is exactly the case here.
      this.stream = createWriteStream(path, { flags: 'a', mode: 0o600 });
      // A write error arrives as an EVENT on a stream, not as a throw from
      // `write` — without this listener node treats it as unhandled and takes
      // the daemon down over a log file.
      this.stream.on('error', (err: Error) => {
        this.fileError = err.message;
      });
      this.streamPath = path;
      this.written = 0;
      // NOT added to `known` and NOT pruned here: this file is the one now
      // being written to. It joins the prunable list when its own stream
      // closes; pruning is driven from there.
      this.prune();
    } catch (err) {
      this.fileError = err instanceof Error ? err.message : String(err);
      this.stream = null;
      this.streamPath = null;
    }
  }

  private rotate(): void {
    this.closeStream();
    this.openStream();
  }

  private closeStream(): void {
    const retiring = this.stream;
    const retiringPath = this.streamPath;
    try {
      if (retiring) {
        // A file becomes prunable only when its stream has fully CLOSED —
        // `end()` alone leaves a flush pending, and deleting then lets that
        // flush recreate the file.
        retiring.once('close', () => {
          if (retiringPath) {
            this.known.push(retiringPath);
          }
          this.prune();
        });
        retiring.end();
      }
    } catch {
      // Already closed / never opened — nothing to do.
    }
    this.stream = null;
    this.streamPath = null;
    this.written = 0;
  }

  /**
   * Log files that are CLOSED and safe to delete, oldest first — previous
   * launches' (seeded at configure, by mtime) plus each of ours as its stream
   * finishes.
   *
   * Both halves of that description were learned the hard way, and both are
   * load-bearing:
   *
   * - tracked rather than re-read from disk, because `createWriteStream` opens
   *   ASYNCHRONOUSLY, so a listing taken during a burst of rotations is always
   *   several files behind and the cap was simply never enforced (measured: 16
   *   files under a cap of 2);
   * - only CLOSED files, because deleting one whose stream has ended but not
   *   yet flushed removes a path that the pending flush then recreates — which
   *   left one extra file behind every time.
   */
  private known: string[] = [];

  /** Seed {@link known} with what previous launches left, oldest first. */
  private seedKnown(): void {
    this.known = [];
    if (!this.dir) {
      return;
    }
    try {
      this.known = readdirSync(this.dir)
        .filter(
          (name) => name.startsWith(FILE_PREFIX) && name.endsWith('.jsonl'),
        )
        .map((name) => {
          const path = join(this.dir!, name);
          return { path, at: statSync(path).mtimeMs };
        })
        .sort((a, b) => a.at - b.at)
        .map((entry) => entry.path);
    } catch {
      // A directory we cannot list is one we also cannot prune; logging still
      // works, which is the part that matters.
    }
  }

  /**
   * Keep the newest {@link maxFiles} logs; delete the rest.
   *
   * The file currently OPEN counts toward the cap but is not in `known`, so
   * the closed list is trimmed to one fewer — otherwise a cap of 2 would keep
   * two closed files plus the live one, which is three.
   */
  private prune(): void {
    const keepClosed = Math.max(0, this.maxFiles - (this.stream ? 1 : 0));
    while (this.known.length > keepClosed) {
      const stale = this.known.shift();
      if (!stale) {
        return;
      }
      try {
        rmSync(stale, { force: true });
      } catch {
        // Pruning is hygiene; a failure must not stop the daemon logging.
      }
    }
  }
}

function truncate(text: string): string {
  if (text.length <= MAX_MESSAGE_LENGTH) {
    return text;
  }
  const dropped = text.length - MAX_MESSAGE_LENGTH;
  // The count is part of the line, so a reader can tell a long-but-complete
  // payload from one this cut — which changes whether the log is evidence.
  return `${text.slice(0, MAX_MESSAGE_LENGTH)}… (+${dropped} chars truncated)`;
}

function redactContext(
  context: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(context)) {
    out[key] = redactSecrets(value);
  }
  return out;
}

/** The one sink. */
export const debugSink = new DebugSink();

/**
 * Point the sink at a directory and start writing files. Called from `main.ts`
 * before the bootstrapper, so the boot lines land too. Unconfigured, the sink
 * still records in memory — which is what keeps unit tests and
 * `pnpm generate:api`'s throwaway daemon from littering the disk.
 */
export function configureDebugSink(options: SinkOptions): void {
  debugSink.configure(options);
}

/** Where the daemon's log files live under a userData dir. */
export const DEBUG_LOG_DIR_NAME = 'logs';
