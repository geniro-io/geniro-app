import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Debounced autosave for the workflow builder, and the save state its status
 * bar reports. The builder has no Save button: an edit persists on its own
 * once the user pauses, so leaving the page can never discard work.
 *
 * Change detection is snapshot-based (graph-doc's `canvasSnapshot`) rather
 * than a dirty flag — the live snapshot IS the effect's dependency, so every
 * keystroke restarts the debounce, and the write that advances `savedSnapshot`
 * settles it. Edits landing DURING a write are not lost: the effect re-runs on
 * the new `savedSnapshot`, finds the canvas dirty again, and re-arms.
 */

/**
 * What the status bar reports. `failed` also surfaces via the error line.
 * `paused` is DERIVED rather than set: the canvas holds edits and autosave is
 * not allowed to write them right now (the builder chat's agent is editing the
 * same file) — which read as "Up to date" while it lasted, over edits that were
 * then lost.
 */
export type AutosaveState = 'idle' | 'saving' | 'saved' | 'failed' | 'paused';

/** Long enough that typing a role prompt is one write, short enough that a
 *  drag settles before the user reaches for the Library button. */
export const AUTOSAVE_DELAY_MS = 700;

export interface UseAutosaveOptions {
  /** False when there is nothing to write to yet (no library slug), or while
   *  a destructive op (delete) is in flight — a stray write would resurrect
   *  the file the user just deleted. */
  enabled: boolean;
  /** The live canvas, serialized exactly as a write would store it. */
  snapshot: string;
  /** The snapshot as last loaded/written; null until a workflow is open. */
  savedSnapshot: string | null;
  /** Persists the canvas. Resolves false when the write failed (the caller
   *  owns surfacing the error text). */
  save: () => Promise<boolean>;
  delayMs?: number;
}

export interface UseAutosaveResult {
  state: AutosaveState;
  /**
   * Write pending edits NOW (leaving the builder) and answer whether the canvas
   * is on disk once it settles. A write already in flight is WAITED FOR, and
   * the canvas written again if it moved on since — returning while an older
   * write is still out would let a leave clear edits nothing had written.
   * `false` means they are NOT saved: the write failed, or autosave is paused
   * over a dirty canvas.
   */
  flush: () => Promise<boolean>;
}

/** One write's outcome, keyed by the snapshot it carried. */
interface WriteResult {
  snapshot: string;
  ok: boolean;
}

export function useAutosave({
  enabled,
  snapshot,
  savedSnapshot,
  save,
  delayMs = AUTOSAVE_DELAY_MS,
}: UseAutosaveOptions): UseAutosaveResult {
  const [state, setState] = useState<Exclude<AutosaveState, 'paused'>>('idle');
  // The ONE write in flight, shared by both entry points (the debounce timer
  // and an explicit flush) so they never overlap — and awaitable, which a
  // boolean flag was not: `flush` has to wait for it rather than skip.
  const inFlight = useRef<Promise<WriteResult> | null>(null);
  // Read by `flush` AFTER an await, when the values its render closed over may
  // be stale — the in-flight write's own state updates have not necessarily
  // been rendered by the time its promise settles.
  const latest = useRef({ enabled, snapshot, savedSnapshot, save });
  latest.current = { enabled, snapshot, savedSnapshot, save };
  const dirty = savedSnapshot !== null && snapshot !== savedSnapshot;

  const write = useCallback(async (target: string): Promise<WriteResult> => {
    const job = (async (): Promise<WriteResult> => {
      setState('saving');
      try {
        const ok = await latest.current.save();
        setState(ok ? 'saved' : 'failed');
        return { snapshot: target, ok };
      } catch {
        // `save` owns error reporting; this only keeps the indicator from
        // claiming "Saved" when the write never landed.
        setState('failed');
        return { snapshot: target, ok: false };
      }
    })();
    inFlight.current = job;
    try {
      return await job;
    } finally {
      if (inFlight.current === job) {
        inFlight.current = null;
      }
    }
  }, []);

  useEffect(() => {
    if (!enabled || !dirty) {
      return;
    }
    const timer = window.setTimeout(() => {
      // A write is already out: it settles `savedSnapshot`, which re-runs this
      // effect, which finds the canvas still dirty and re-arms.
      if (inFlight.current === null) {
        void write(snapshot);
      }
    }, delayMs);
    return () => window.clearTimeout(timer);
  }, [enabled, dirty, snapshot, savedSnapshot, delayMs, write]);

  const flush = useCallback(async (): Promise<boolean> => {
    const target = latest.current.snapshot;
    let baseline = latest.current.savedSnapshot;
    const pending = inFlight.current;
    if (pending !== null) {
      const landed = await pending;
      // What is on disk now is what that write carried — `savedSnapshot` may
      // not have been re-rendered with it yet.
      if (landed.ok) {
        baseline = landed.snapshot;
      }
    }
    if (baseline === null || baseline === target) {
      return true;
    }
    if (!latest.current.enabled) {
      return false;
    }
    return (await write(target)).ok;
  }, [write]);

  return {
    state: !enabled && dirty && state !== 'saving' ? 'paused' : state,
    flush,
  };
}
