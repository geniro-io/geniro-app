import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { Injectable, Logger } from '@nestjs/common';

import { environment } from '../../../environments';
import { atomicWriteSync } from '../../../utils/atomic-file';

/**
 * Defensive bound. One entry per (agent, model) the user has ever run; a
 * machine with more distinct models than this is not a real installation, and
 * an unbounded file is one that grows forever on a caller writing in a loop.
 */
const MAX_ENTRIES = 500;

/**
 * Refuse to read a store larger than this.
 *
 * The entry cap alone does not bound the WORK: `readFileSync` + `JSON.parse`
 * materialise the whole file before a single entry is validated, and a file of
 * nothing but invalid pairs never reaches the entry cap at all. This read
 * happens on the live-delta path, so an oversized or corrupt store would block
 * the event loop mid-turn — the one thing this cache must never cost. 500
 * entries of `"claude\u0000some-model": 1000000` is a few tens of KB, so 256 KB
 * is roomy for anything this file legitimately holds.
 */
const MAX_STORE_BYTES = 256 * 1024;

/**
 * The (agent, model, window choice) key — THE one, exported so the live plane's
 * in-memory half and this durable half cannot spell it differently.
 *
 * Keyed by AGENT as well as model because two CLIs can name the same model and
 * a window measured through one says nothing about the other —
 * `.claude/rules/agent-adapters.md` states it flatly: per-agent state is keyed
 * by agent, never by the thing it is about.
 *
 * **And by the WINDOW CHOICE**, which is the third component rather than a
 * second store. One model genuinely has more than one window — cursor's
 * `kimi-k3` measures 200,000 on its standard setting and 1,048,576 on Max Mode
 * — so a two-part key files both under one entry and each turn overwrites the
 * other's figure. The meter would then scale a 1M conversation against 200k
 * (or the reverse) for as long as the wrong reading stood, which is the exact
 * "1M shown as 200k" class of defect `rememberWindow` already guards against
 * from the other direction. `''` is the third state and a real one: a run that
 * named no window runs at whatever the model's own default is, which is not
 * the same fact as either named choice.
 *
 * NUL-joined, the same key shape `McpSettingsStore` and `SkillHarvestStore`
 * use, because no model id a CLI reports contains that byte — so the parts
 * cannot be re-partitioned into different ones. Note the premise is weaker
 * than the sibling stores': a path CANNOT contain a NUL, whereas a model id is
 * an arbitrary CLI-reported string that merely never does.
 */
export function contextWindowKey(
  agent: string,
  model: string,
  contextWindow: string | null = null,
): string {
  return `${agent}\u0000${model}\u0000${(contextWindow ?? '').trim()}`;
}

/** Constructor options — a test seam, not user config. */
export interface ContextWindowStoreOptions {
  /** The store file; defaults to `<userData>/context-windows.json`. */
  file?: string;
}

/**
 * The context window each (agent, model) last reported, ACROSS daemon launches.
 *
 * Persisted rather than process-lifetime, and that reversal is the whole point.
 * A window rides the `result` line only — probe-verified on claude 2.1.220 and
 * again on 2.1.x here: `result.modelUsage[<model>].contextWindow`, absent from
 * every `assistant` line. Holding it in memory alone therefore meant a run had
 * nothing to scale against until its own first turn COMPLETED in the current
 * process, so every chat rendered a denominator-less meter for the whole of
 * its first turn after each app launch. On a machine where the app is
 * restarted often that is most of what the user ever sees, which is exactly
 * the "I don't see full context and circle" report this store answers.
 *
 * It stays a CACHE of something the CLI will report again, never a source of
 * truth: a model whose window has never been observed is absent, and the meter
 * shows the count with no ring rather than measuring against a guess — the
 * deliberate behaviour `context-meter.tsx` documents. A `result` line always
 * overwrites what is stored here, so a model whose window changes is corrected
 * by the next completed turn rather than needing a migration.
 *
 * Reads are SYNCHRONOUS for the same reason `McpSettingsStore`'s are: the
 * caller is the live-delta path, which publishes inside the persist chain. The
 * file is a few hundred bytes and is parsed once per daemon launch.
 */
@Injectable()
export class ContextWindowStore {
  private readonly logger = new Logger(ContextWindowStore.name);
  private readonly file: string;
  private records: Map<string, number> | null = null;

  constructor(options: ContextWindowStoreOptions = {}) {
    this.file =
      options.file ?? join(environment.userDataDir, 'context-windows.json');
  }

  /** The window this model reported last, or null when never observed. */
  get(
    agent: string,
    model: string,
    contextWindow: string | null = null,
  ): number | null {
    return (
      this.load().get(contextWindowKey(agent, model, contextWindow)) ?? null
    );
  }

  /**
   * Record the window a model reported. A non-positive figure is REJECTED
   * rather than stored: consumers read this as "the window", and a zero would
   * be divided by. Unchanged values do not rewrite the file — a turn completing
   * every few seconds must not mean a disk write every few seconds.
   */
  remember(
    agent: string,
    model: string,
    window: number,
    contextWindow: string | null = null,
  ): void {
    if (!Number.isFinite(window) || window <= 0) {
      return;
    }
    const records = this.load();
    const key = contextWindowKey(agent, model, contextWindow);
    if (records.get(key) === window) {
      return;
    }
    if (!records.has(key) && records.size >= MAX_ENTRIES) {
      // Dropping an entry to admit this one would evict a model the user may
      // be using right now; refusing to grow keeps the file bounded and costs
      // only the ring on a model this machine has never run before.
      return;
    }
    records.set(key, window);
    this.save(records);
  }

  private load(): Map<string, number> {
    if (this.records !== null) {
      return this.records;
    }
    const records = new Map<string, number>();
    try {
      if (statSync(this.file).size > MAX_STORE_BYTES) {
        throw new Error('context-window cache is implausibly large');
      }
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (typeof parsed === 'object' && parsed !== null) {
        let seen = 0;
        for (const [key, value] of Object.entries(parsed)) {
          // Counted per ITERATION, not per accepted entry: a file of nothing
          // but invalid pairs would otherwise never reach the cap at all, and
          // the loop this cap exists to bound would run over every one of them.
          if (++seen > MAX_ENTRIES) {
            break;
          }
          // Validated per entry rather than per file: one corrupted key must
          // not discard every other model's window.
          if (
            typeof value === 'number' &&
            Number.isFinite(value) &&
            value > 0 &&
            // Exactly three parts, so an entry written before the window
            // choice joined the key is DROPPED rather than kept as a row no
            // lookup can ever match. Left in, such a row would hold one of the
            // {@link MAX_ENTRIES} slots for the life of the install.
            key.split('\u0000').length === 3
          ) {
            records.set(key, value);
          }
        }
      }
    } catch {
      // Missing or malformed — nothing is known, which is the same state a
      // fresh install is in. The next write replaces the file wholesale, so a
      // corrupt one repairs itself rather than needing a migration.
    }
    this.records = records;
    return records;
  }

  /**
   * Write the map out, SYNCHRONOUSLY — for the reasons spelled out on
   * `ModelVocabularyStore.save`, which had the same floating promise and the
   * same two consequences: an older snapshot could win the rename race between
   * two `remember` calls in one tick, and nothing could know when the write was
   * over. This store is the cheaper of the two to write (a number per entry).
   */
  private save(records: Map<string, number>): void {
    // The in-memory map is updated before the write, so a disk failure leaves
    // this daemon scaling the meter correctly while warning that the knowledge
    // will not survive a restart.
    this.records = records;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      atomicWriteSync(
        this.file,
        JSON.stringify(Object.fromEntries(records), null, 2),
      );
    } catch (err) {
      this.logger.warn(
        `context-window cache write failed (this session only, lost on restart): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
