import { useEffect, useState } from 'react';

import type { BrowserRunState } from '../../../shared/contracts';

/** One chat's in-app browser, read once and then followed through main's events. */
export function useBrowserState(runId: string): BrowserRunState | null {
  const [state, setState] = useState<BrowserRunState | null>(null);

  useEffect(() => {
    let pushed = false;
    let cancelled = false;
    setState(null);
    const unsubscribe = window.geniro.onBrowserState((event) => {
      if (event.state.runId === runId) {
        pushed = true;
        setState(event.state);
      }
    });
    window.geniro
      .browserState(runId)
      .then((read) => {
        if (!cancelled && !pushed) {
          setState(read);
        }
      })
      .catch(() => {
        if (!cancelled && !pushed) {
          setState({
            runId,
            tabs: [],
            activeTabId: null,
            poppedOut: false,
            recent: [],
          });
        }
      });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [runId]);

  return state;
}
