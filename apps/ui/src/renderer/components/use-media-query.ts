import { useEffect, useState } from 'react';

/**
 * `window.matchMedia` itself, guarded rather than called bare: every runtime
 * this app ships to has it, jsdom does not, and a spec that mounts a component
 * on this hook to test something else must not have to stub it. `false` is the
 * answer every desktop-focused spec already assumes.
 */
function matches(query: string): boolean {
  return (
    typeof window.matchMedia === 'function' && window.matchMedia(query).matches
  );
}

/** Whether the media query matches now, followed as it changes. */
export function useMediaQuery(query: string): boolean {
  const [matched, setMatched] = useState(() => matches(query));

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') {
      return;
    }
    const mql = window.matchMedia(query);
    const onChange = (): void => setMatched(mql.matches);
    // The query can change between renders, so the current match is read again
    // rather than trusted from the previous query's state.
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return matched;
}
