import { Injectable } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';

import type { TurnStdioSink } from '../adapters/adapter.types';
import { CappedTextBuffer, SCROLLBACK_CAP } from '../utils/capped-text-buffer';

/**
 * Max mirrored output retained per (run, node), in chars.
 *
 * Re-exported from the shared cap rather than declared: the PTY session's
 * scrollback uses the same one, and the panel must not hold a different amount
 * of history depending on which kind of mirror it opened.
 */
export const MIRROR_BUFFER_CAP = SCROLLBACK_CAP;

/**
 * Max mirrored nodes retained at once.
 *
 * The buffers outlive their turns on purpose (that is what lets the panel show
 * the last turn when nothing is running), so without a ceiling a long session
 * across many chats would accumulate one capped buffer per node it ever ran.
 */
// Exported so the spec pins eviction against the live constant.
export const MAX_MIRRORS = 64;

/** SGR wrappers. Terminal palette, resolved by the viewer's own theme. */
const DIM = '\u001b[2m';
const RED = '\u001b[31m';
const RESET = '\u001b[0m';

interface MirrorBuffer {
  text: CappedTextBuffer;
  events: Subject<string>;
  /**
   * How many turns are writing right now — an idle buffer (zero) is safe to
   * evict and has genuinely ended.
   *
   * A COUNT, not a flag, because one node runs several turns at once: a
   * callable DAG node holds its own turn plus up to `MAX_PARALLEL_SUB_TURNS`
   * callee sub-turns, and they all share this buffer. With a flag the first one
   * to finish would declare the node idle — printing "turn ended" into a stream
   * still being written, and re-exposing the buffer to eviction mid-run.
   */
  liveTurns: number;
  touchedAt: number;
}

/**
 * The live terminal mirror's buffer: raw child stdio of a run's turns, keyed by
 * (run, node), held in memory and never persisted.
 *
 * EPHEMERAL, like `PartialStreamService` — it is the process plane, not
 * history. SQLite holds what a turn MEANT (items); this holds what its process
 * PRINTED, which no other surface in the app shows at all. It is therefore
 * never replayed from the database: a mirror opened before this daemon ever ran
 * a turn for that node has nothing to show, and says so rather than
 * reconstructing bytes it never saw.
 *
 * A buffer spans TURNS, not processes. Each turn appends its own banner and
 * output to the same buffer, so the panel follows the conversation the way a
 * real shell follows a session — which is exactly what the separate
 * `--resume` PTY mirror could not do.
 */
@Injectable()
export class TurnMirrorService {
  private readonly buffers = new Map<string, MirrorBuffer>();
  /** Monotonic stamp for LRU eviction — never a wall clock, so it cannot go backwards. */
  private tick = 0;

  /**
   * The sink one turn writes through. Creating it also creates the buffer, so a
   * mirror opened mid-turn finds the output already accumulating.
   *
   * Every call re-resolves the buffer BY KEY, and resolves it WITHOUT creating.
   * Both halves matter, because a buffer can be removed underneath a running
   * turn — `RunTeardownService` waits a bounded 5s for in-flight work and then
   * drops anyway, and `settled` always lands a tick later than the child. A
   * captured reference would append into an orphan the map no longer holds;
   * re-resolving through `ensure` would do the opposite and RESURRECT a deleted
   * run's buffer, which nothing would ever drop again. Resolving without
   * creating means a straggler's output simply goes nowhere, which is the
   * honest outcome for a run that no longer exists.
   */
  sink(runId: string, nodeId: string): TurnStdioSink {
    const key = mirrorKey(runId, nodeId);
    this.ensure(key);
    // Whether THIS turn is one of the buffer's live turns. Per-sink, because a
    // sink is per-turn: without it, a turn that settled without ever spawning
    // (a bad argv, a failed `prepareTurn`) would decrement a count it never
    // raised and declare a SIBLING's turn finished. It also makes the release
    // naturally once-only across `settled`'s several exit paths.
    let raised = false;
    return {
      spawned: (command, args) => {
        const buffer = this.find(key);
        if (!buffer) {
          return;
        }
        if (!raised) {
          raised = true;
          buffer.liveTurns += 1;
        }
        this.append(
          buffer,
          `${DIM}$ ${[command, ...args].map(quoteArg).join(' ')}${RESET}\r\n`,
        );
      },
      data: (stream, chunk) => {
        const buffer = this.find(key);
        if (!buffer) {
          return;
        }
        // stderr is tinted so it is distinguishable from stdout in one
        // interleaved stream; the bytes themselves are untouched.
        this.append(
          buffer,
          stream === 'stderr' ? `${RED}${chunk}${RESET}` : chunk,
        );
      },
      settled: () => {
        const buffer = this.find(key);
        if (!buffer || !raised) {
          return;
        }
        // Released BEFORE the marker is appended: a buffer with live turns is
        // exempt from eviction, so a turn that failed to release would pin its
        // node's buffer forever and quietly disable the MAX_MIRRORS ceiling.
        raised = false;
        buffer.liveTurns -= 1;
        if (buffer.liveTurns === 0) {
          // Only the LAST turn of the node prints the marker; a fan-out node's
          // first finisher does not get to announce that the node is done.
          this.append(buffer, `${DIM}— turn ended —${RESET}\r\n`);
        }
      },
    };
  }

  /** Everything buffered for this node so far, for a client attaching now. */
  snapshot(runId: string, nodeId: string): string {
    return this.buffers.get(mirrorKey(runId, nodeId))?.text.snapshot() ?? '';
  }

  /**
   * Live appends for one node. Attach protocol mirrors the PTY's: read
   * {@link snapshot} and subscribe in the same synchronous tick, so no chunk
   * can slip between the two.
   *
   * Subscribing CREATES the buffer when none exists — a mirror opened before
   * the node's first turn must be attached and waiting, not silently inert.
   */
  stream(runId: string, nodeId: string): Observable<string> {
    return this.ensure(mirrorKey(runId, nodeId)).events.asObservable();
  }

  /**
   * Forget every buffer of one run — its output describes a run that no longer
   * exists. Completing each subject tells any attached mirror the stream ended
   * instead of leaving it on a live badge over a dead buffer.
   */
  drop(runId: string): void {
    const prefix = mirrorKey(runId, '');
    for (const [key, buffer] of this.buffers) {
      if (key.startsWith(prefix)) {
        buffer.events.complete();
        this.buffers.delete(key);
      }
    }
  }

  /**
   * The buffer for a key, or undefined — never created. The read a WRITER uses:
   * a turn writes to whatever buffer is there, and to nothing when its run has
   * been deleted out from under it.
   */
  private find(key: string): MirrorBuffer | undefined {
    const buffer = this.buffers.get(key);
    if (buffer) {
      buffer.touchedAt = ++this.tick;
    }
    return buffer;
  }

  private ensure(key: string): MirrorBuffer {
    const existing = this.buffers.get(key);
    if (existing) {
      existing.touchedAt = ++this.tick;
      return existing;
    }
    this.evictIfFull();
    const buffer: MirrorBuffer = {
      text: new CappedTextBuffer(),
      events: new Subject<string>(),
      liveTurns: 0,
      touchedAt: ++this.tick,
    };
    this.buffers.set(key, buffer);
    return buffer;
  }

  /**
   * Make room for one more buffer by dropping the least recently touched one
   * that is neither mid-turn nor being watched.
   *
   * Both exclusions matter, and for the same reason: eviction COMPLETES the
   * subject, and a live mirror session treats that as "the stream ended".
   * Evicting a mid-turn buffer would blind a mirror the user is watching right
   * now; evicting a watched IDLE one is worse, because the next turn calls
   * `ensure` and gets a NEW subject — leaving the panel parked on "ended"
   * while the agent runs, which is precisely the standstill this whole feature
   * exists to remove.
   */
  private evictIfFull(): void {
    while (this.buffers.size >= MAX_MIRRORS) {
      let oldestKey: string | null = null;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [key, buffer] of this.buffers) {
        if (
          buffer.liveTurns === 0 &&
          // `observed` is false once every mirror session has unsubscribed —
          // which `TerminalSessionsService` does when the panel closes, so a buffer stops
          // being pinned as soon as nobody is looking at it.
          !buffer.events.observed &&
          buffer.touchedAt < oldestAt
        ) {
          oldestAt = buffer.touchedAt;
          oldestKey = key;
        }
      }
      if (oldestKey === null) {
        // Every buffer is either mid-turn or being watched. Refusing to evict is
        // the safe answer: the new buffer is created anyway (going over the
        // ceiling beats dropping a mirror someone is using), and the next settle
        // or panel close brings the map back under it.
        return;
      }
      // Deleted, NOT completed. Only an unwatched buffer reaches here, so there
      // is no subscriber to notify — and completing the subject would be the
      // wrong signal anyway: the node has not ended, its history was merely
      // aged out. `drop()` is the one that completes, because a deleted run's
      // mirrors genuinely have ended.
      this.buffers.delete(oldestKey);
    }
  }

  private append(buffer: MirrorBuffer, text: string): void {
    if (!buffer.text.push(text)) {
      return;
    }
    buffer.touchedAt = ++this.tick;
    buffer.events.next(text);
  }
}

/**
 * The (run, node) key. NUL-separated for the same reason as
 * `contextWindowKey`: a node id is user-authored in workflow YAML, so any
 * printable separator is a character a node could legitimately contain, and two
 * different pairs would then collide onto one buffer.
 */
export function mirrorKey(runId: string, nodeId: string): string {
  return `${runId}\u0000${nodeId}`;
}

/**
 * Render one argv entry for the banner. Quoted only when it contains
 * whitespace or a quote — the point is a line the user could paste back into a
 * shell, not a faithful re-encoding of every metacharacter.
 */
function quoteArg(arg: string): string {
  return /[\s"']/.test(arg) ? `'${arg.replace(/'/g, `'\\''`)}'` : arg;
}
