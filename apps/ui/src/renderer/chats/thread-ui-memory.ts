import {
  createContext,
  type Dispatch,
  type SetStateAction,
  useCallback,
  useContext,
  useState,
  useSyncExternalStore,
} from 'react';

/**
 * The thread whose UI state the components below are remembering — the open
 * run's id, or null where no thread is open.
 *
 * REPORTED as "когда я открываю правый сайдбар… либо открываю какой-то блок,
 * он коллапсит… они не сохраняются между переходами по тредам": the agents
 * panel's fold was ONE global flag, so folding it in one thread folded it in
 * every thread, while every transcript fold was component state and came undone
 * the moment the thread was left. Both were answering the wrong question — what
 * is folded is a fact about a THREAD, so it is remembered per thread.
 *
 * A context and not a prop: the folds sit several memoized layers below the
 * screen (turn block → group → row), and threading a run id through each one
 * would re-render all of them on a switch none of them is otherwise about.
 * Outside a provider — a spec, a surface that is not a thread — every hook here
 * degrades to plain component state, which is exactly the behaviour before.
 */
export const ThreadUiMemoryContext = createContext<string | null>(null);

const KEY_PREFIX = 'geniro.threadUi.';
const INDEX_KEY = `${KEY_PREFIX}index`;

/**
 * How many threads are remembered at all. A press writes, nothing else does, so
 * this is threads the user actually touched — and the oldest of those is
 * forgotten first, which costs one fold going back to its default.
 */
export const MAX_REMEMBERED_THREADS = 200;

/**
 * How many folds one thread remembers. A long thread has hundreds of tool rows,
 * and a reader opening them one by one should not grow a localStorage entry
 * without bound; the least recently pressed goes first.
 */
export const MAX_FLAGS_PER_THREAD = 500;

/**
 * Parsed entries, validated against the RAW string they were parsed from.
 *
 * Re-reading storage on every snapshot rather than trusting the cache alone is
 * what keeps a second window, and a spec's `localStorage.clear()`, from being
 * answered with a value that is no longer stored — while the string compare
 * keeps a streamed-token re-render from re-parsing JSON.
 */
const parsed = new Map<string, { raw: string; flags: Map<string, boolean> }>();
const listeners = new Map<string, Set<() => void>>();
const versions = new Map<string, number>();

function storageKey(runId: string): string {
  return KEY_PREFIX + runId;
}

function flagsOf(runId: string): Map<string, boolean> {
  const raw = localStorage.getItem(storageKey(runId));
  if (raw === null) {
    parsed.delete(runId);
    return new Map();
  }
  const cached = parsed.get(runId);
  if (cached?.raw === raw) {
    return cached.flags;
  }
  const flags = new Map<string, boolean>();
  try {
    const value: unknown = JSON.parse(raw);
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const [key, flag] of Object.entries(value)) {
        if (typeof flag === 'boolean') {
          flags.set(key, flag);
        }
      }
    }
  } catch {
    // A corrupt entry reads as nothing remembered — every fold falls back to
    // its own default, and the next press overwrites it.
  }
  parsed.set(runId, { raw, flags });
  return flags;
}

function announce(runId: string): void {
  versions.set(runId, (versions.get(runId) ?? 0) + 1);
  for (const notify of listeners.get(runId) ?? []) {
    notify();
  }
}

function subscribe(runId: string, notify: () => void): () => void {
  const group = listeners.get(runId) ?? new Set<() => void>();
  group.add(notify);
  listeners.set(runId, group);
  return () => {
    group.delete(notify);
    if (group.size === 0) {
      listeners.delete(runId);
    }
  };
}

function readIndex(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(INDEX_KEY) ?? '[]');
    return Array.isArray(value)
      ? value.filter((id): id is string => typeof id === 'string')
      : [];
  } catch {
    return [];
  }
}

/** Move `runId` to the recent end, forgetting whatever falls off the old end. */
function touchIndex(runId: string): void {
  const index = readIndex().filter((id) => id !== runId);
  index.push(runId);
  while (index.length > MAX_REMEMBERED_THREADS) {
    const evicted = index.shift();
    if (evicted !== undefined) {
      localStorage.removeItem(storageKey(evicted));
      parsed.delete(evicted);
      announce(evicted);
    }
  }
  localStorage.setItem(INDEX_KEY, JSON.stringify(index));
}

/** What the user last chose for `key` in this thread, or null for never. */
export function readThreadFlag(runId: string, key: string): boolean | null {
  return flagsOf(runId).get(key) ?? null;
}

/** Remember a choice for `key` in this thread, and wake everyone reading it. */
export function writeThreadFlag(
  runId: string,
  key: string,
  value: boolean,
): void {
  // A copy, so the cached map is never mutated behind a snapshot that still
  // holds it; delete-then-set moves the key to the recent end for eviction.
  const flags = new Map(flagsOf(runId));
  flags.delete(key);
  flags.set(key, value);
  while (flags.size > MAX_FLAGS_PER_THREAD) {
    const oldest = flags.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    flags.delete(oldest);
  }
  localStorage.setItem(
    storageKey(runId),
    JSON.stringify(Object.fromEntries(flags)),
  );
  touchIndex(runId);
  announce(runId);
}

/**
 * Drop everything remembered about a thread that no longer exists.
 *
 * Called on a permanent delete: nothing can ever show that thread again, so
 * its folds are only storage — the same rule `forgetContextReading` follows.
 */
export function forgetThread(runId: string): void {
  localStorage.removeItem(storageKey(runId));
  parsed.delete(runId);
  localStorage.setItem(
    INDEX_KEY,
    JSON.stringify(readIndex().filter((id) => id !== runId)),
  );
  announce(runId);
}

const noSubscription = (): (() => void) => () => {};

/**
 * The reader's own press on one fold of the open thread, or null when they have
 * not pressed it — the OVERRIDE half of the folds that derive their default
 * (a tool group holding a diff opens itself; the latest task card is open).
 *
 * `key` names the fold within the thread and must be stable across mounts —
 * the id of the row it belongs to, never an index into a window that pages.
 * Without a key, or outside a {@link ThreadUiMemoryContext}, it is component
 * state and forgets on unmount, as before.
 */
export function useThreadOverride(
  key: string | undefined,
): [boolean | null, (value: boolean) => void] {
  const runId = useContext(ThreadUiMemoryContext);
  const [local, setLocal] = useState<boolean | null>(null);
  const scopedRun = key === undefined ? null : runId;
  const subscribeToRun = useCallback(
    (notify: () => void) =>
      scopedRun === null ? noSubscription() : subscribe(scopedRun, notify),
    [scopedRun],
  );
  const remembered = useSyncExternalStore(subscribeToRun, () =>
    scopedRun === null || key === undefined
      ? null
      : readThreadFlag(scopedRun, key),
  );
  const set = useCallback(
    (value: boolean) => {
      if (scopedRun === null || key === undefined) {
        setLocal(value);
      } else {
        writeThreadFlag(scopedRun, key, value);
      }
    },
    [scopedRun, key],
  );
  return [scopedRun === null ? local : remembered, set];
}

/**
 * A boolean of the open thread with a fixed default — `useState`'s shape,
 * updater form included, remembered per thread.
 */
export function useThreadFlag(
  key: string | undefined,
  fallback: boolean,
): [boolean, Dispatch<SetStateAction<boolean>>] {
  const [override, setOverride] = useThreadOverride(key);
  const value = override ?? fallback;
  const set = useCallback<Dispatch<SetStateAction<boolean>>>(
    (next) => setOverride(typeof next === 'function' ? next(value) : next),
    [setOverride, value],
  );
  return [value, set];
}

/**
 * Every fold of the open thread at once, for a component that draws a VARIABLE
 * number of them (one per agent card) and so cannot call a hook per fold.
 * Re-renders on any write to the thread; outside a provider it is component
 * state keyed the same way.
 */
export function useThreadFlags(): {
  get: (key: string) => boolean | null;
  set: (key: string, value: boolean) => void;
} {
  const runId = useContext(ThreadUiMemoryContext);
  const [local, setLocal] = useState<ReadonlyMap<string, boolean>>(new Map());
  const subscribeToRun = useCallback(
    (notify: () => void) =>
      runId === null ? noSubscription() : subscribe(runId, notify),
    [runId],
  );
  // The version is the snapshot: it moves on every write, which is what a
  // many-fold reader has to re-render for.
  useSyncExternalStore(subscribeToRun, () =>
    runId === null ? 0 : (versions.get(runId) ?? 0),
  );
  if (runId === null) {
    return {
      get: (key) => local.get(key) ?? null,
      set: (key, value) => setLocal((prev) => new Map(prev).set(key, value)),
    };
  }
  return {
    get: (key) => readThreadFlag(runId, key),
    set: (key, value) => writeThreadFlag(runId, key, value),
  };
}
