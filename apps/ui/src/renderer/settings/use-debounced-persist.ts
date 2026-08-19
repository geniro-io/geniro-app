import { useCallback, useEffect, useRef } from 'react';

/** How long a field waits after the last keystroke before it is written. */
const DEBOUNCE_MS = 600;

export interface DebouncedPersist<T> {
  /**
   * Record a new value and arm the write. `savable` deciding false records the
   * value but arms nothing — the field keeps what the user typed on screen
   * while the store keeps the last legal value.
   */
  schedule: (value: T) => void;
  /** True once `schedule` has been called — guards a late initial read. */
  dirtyRef: React.RefObject<boolean>;
}

/**
 * A settings field that saves itself a moment after the user stops typing, and
 * again on the way out if that moment never arrived.
 *
 * Extracted because Settings had grown two hand-rolled copies of the same five
 * moving parts — a latest-value ref and its mirror effect, a timer ref, an
 * unmount flush with its own catch, and a dirty ref — and a third field would
 * have been a third copy. The parts are individually trivial and collectively
 * exactly where the bugs were: the instructions field shipped a version whose
 * `clearTimeout` left a non-null handle, so an unsavable edit following a legal
 * one still flushed the unsavable text on unmount.
 *
 * Two rules the hook holds so no caller has to remember them:
 *
 * - **The flush on unmount is what makes this safe to leave mid-sentence.**
 *   Navigating away inside the debounce window must not discard the edit.
 * - **`savable` gates the ARMING, not the write.** A value the store would
 *   reject never arms a timer, so the flush cannot fire one either — the
 *   nulled handle is the whole mechanism, and it is here rather than in each
 *   caller.
 */
export function useDebouncedPersist<T>(
  /** Writes the value. Rejections are the caller's to surface. */
  write: (value: T) => Promise<unknown>,
  /**
   * Whether this value can actually be stored. A value that fails is held on
   * screen and never written — the caller shows why.
   */
  savable: (value: T) => boolean = () => true,
): DebouncedPersist<T> {
  const latest = useRef<T | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirtyRef = useRef(false);
  // Kept in refs so the unmount effect can stay dependency-free: it must run
  // exactly once, on the way out, with whatever the latest values are.
  const writeRef = useRef(write);
  writeRef.current = write;

  useEffect(
    () => () => {
      if (!timer.current) {
        return;
      }
      clearTimeout(timer.current);
      timer.current = null;
      const pending = latest.current;
      if (pending === null) {
        return;
      }
      void writeRef.current(pending).catch((err: unknown) => {
        console.error('failed to flush a settings field on unmount', err);
      });
    },
    [],
  );

  const schedule = useCallback(
    (value: T): void => {
      dirtyRef.current = true;
      latest.current = value;
      if (timer.current) {
        clearTimeout(timer.current);
        // NULLED, not merely cleared: the unmount flush tests this handle, so
        // a cleared-but-non-null one lets a legal edit followed by an
        // unsavable one flush the unsavable value on the way out.
        timer.current = null;
      }
      if (!savable(value)) {
        return;
      }
      timer.current = setTimeout(() => {
        timer.current = null;
        void writeRef.current(value);
      }, DEBOUNCE_MS);
    },
    [savable],
  );

  return { schedule, dirtyRef };
}
