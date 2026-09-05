import { useEffect, useState } from 'react';

/**
 * One re-render a second, for as long as `active`.
 *
 * A live readout owns its own ticking rather than being repainted from above —
 * the transcript's live rows follow the same rule, and a clock driven from a
 * parent repaints every sibling once a second to move one number.
 *
 * Shared rather than copied because the header's thread total and a card's
 * per-agent figure are the same quantity at two scopes: two intervals is how
 * they would come to disagree about when a second has passed.
 */
export function useSecondTick(active: boolean): void {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!active) {
      return;
    }
    const id = window.setInterval(() => tick((n) => n + 1), 1_000);
    return () => window.clearInterval(id);
  }, [active]);
}
