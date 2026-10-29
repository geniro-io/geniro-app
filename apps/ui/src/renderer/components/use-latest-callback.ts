import { type DependencyList, type RefObject, useMemo, useRef } from 'react';

type Callback = (...args: never[]) => unknown;

/**
 * `useCallback` whose kept function holds no render's scope: its identity
 * changes when `deps` do, and a call runs the latest render's `callback`.
 */
export function useLatestCallback<T extends Callback>(
  callback: T,
  deps: DependencyList,
): T {
  const latest = useRef(callback);
  // Written during render: a child rendered in the same pass may call it.
  latest.current = callback;
  return useMemo(() => forwarderTo(latest), deps);
}

function forwarderTo<T extends Callback>(latest: RefObject<T>): T {
  const forward = (...args: Parameters<T>): ReturnType<T> =>
    Reflect.apply(latest.current, undefined, args) as ReturnType<T>;
  return forward as unknown as T;
}
