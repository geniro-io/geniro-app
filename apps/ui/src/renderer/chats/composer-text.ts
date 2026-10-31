import { useSyncExternalStore } from 'react';

/**
 * The chat screen's composer text, held outside React state.
 *
 * As state on the screen, every keystroke re-rendered the header, the
 * transcript list and the agents panel to draw one character — on a phone, a
 * visible lag per key on a long thread. The textarea subscribes to the whole
 * text; the screen subscribes only to the facts it draws from it
 * ({@link useComposerTextFact}), which change a few times per message.
 */
export interface ComposerText {
  get: () => string;
  /** A value or an updater, as `setState` takes one; applied at once. */
  set: (next: string | ((current: string) => string)) => void;
  subscribe: (listener: () => void) => () => void;
}

export function createComposerText(initial = ''): ComposerText {
  let text = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => text,
    set: (next) => {
      const value = typeof next === 'function' ? next(text) : next;
      if (value === text) {
        return;
      }
      text = value;
      for (const listener of [...listeners]) {
        listener();
      }
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** The whole text, for the field that edits it. */
export function useComposerTextValue(store: ComposerText): string {
  return useSyncExternalStore(store.subscribe, store.get);
}

/**
 * One fact read off the text: the caller re-renders only when it changes, so
 * `read` must answer a primitive (or a value it keeps stable).
 */
export function useComposerTextFact<T>(
  store: ComposerText,
  read: (text: string) => T,
): T {
  return useSyncExternalStore(store.subscribe, () => read(store.get()));
}
