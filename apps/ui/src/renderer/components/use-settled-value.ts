import { useEffect, useState } from 'react';

/**
 * `value` once it has held for `ms`, and `unsettled` until it first has: a
 * reading taken while a layout is still settling is not acted on.
 */
export function useSettledValue<T>(value: T, ms: number, unsettled: T): T {
  const [settled, setSettled] = useState<T>(unsettled);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}
