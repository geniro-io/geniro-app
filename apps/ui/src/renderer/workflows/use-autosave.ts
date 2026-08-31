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

/** What the status bar reports. `failed` also surfaces via the error line. */
export type AutosaveState = 'idle' | 'saving' | 'saved' | 'failed';

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
  /** Write pending edits NOW (leaving the builder) — resolves once settled. */
  flush: () => Promise<void>;
}

export function useAutosave({
  enabled,
  snapshot,
  savedSnapshot,
  save,
  delayMs = AUTOSAVE_DELAY_MS,
}: UseAutosaveOptions): UseAutosaveResult {
  const [state, setState] = useState<AutosaveState>('idle');
  // Holds the one-write-at-a-time invariant across BOTH entry points (the
  // debounce timer and an explicit flush) without re-rendering on every write.
  const writing = useRef(false);
  const dirty = savedSnapshot !== null && snapshot !== savedSnapshot;

  const write = useCallback(async (): Promise<void> => {
    if (writing.current) {
      return;
    }
    writing.current = true;
    setState('saving');
    try {
      setState((await save()) ? 'saved' : 'failed');
    } catch {
      // `save` owns error reporting; this only keeps the indicator from
      // claiming "Saved" when the write never landed.
      setState('failed');
    } finally {
      writing.current = false;
    }
  }, [save]);

  useEffect(() => {
    if (!enabled || !dirty) {
      return;
    }
    const timer = window.setTimeout(() => void write(), delayMs);
    return () => window.clearTimeout(timer);
  }, [enabled, dirty, snapshot, savedSnapshot, delayMs, write]);

  const flush = useCallback(async (): Promise<void> => {
    if (enabled && dirty) {
      await write();
    }
  }, [enabled, dirty, write]);

  return { state, flush };
}
