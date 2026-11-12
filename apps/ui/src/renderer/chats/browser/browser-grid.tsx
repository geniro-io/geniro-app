import { useEffect, useMemo, useRef } from 'react';

import { useLatestCallback } from '../../components/use-latest-callback';
import {
  readThreadFlag,
  useThreadFlag,
  writeThreadFlag,
} from '../thread-ui-memory';
import { BrowserPaneContext } from './browser-pane-context';
import {
  BROWSER_PANE_OPEN_KEY,
  clearAgentTabUnseen,
  markAgentTabUnseen,
} from './browser-pane-store';

/**
 * The chat screen's grid, with the open chat's browser offered to everything in
 * it (the transcript's links first of all).
 *
 * Its own component so the pane's open state and the agent-tab events stay off
 * Chats' render path: this re-renders on them, its `children` do not.
 */
export function BrowserGrid({
  runId,
  className,
  style,
  children,
}: {
  /** The open chat, or null where no browser is offered (no run, a paired device, a hosted screen). */
  runId: string | null;
  className?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
}): React.JSX.Element {
  const [open, setOpen] = useThreadFlag(BROWSER_PANE_OPEN_KEY, false);
  const openRef = useRef(open);
  openRef.current = open;
  const runIdRef = useRef<string | null>(runId);
  runIdRef.current = runId;

  const enabled = runId !== null;

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const openColumn = (id: string): void => {
      if (readThreadFlag(id, BROWSER_PANE_OPEN_KEY) !== true) {
        writeThreadFlag(id, BROWSER_PANE_OPEN_KEY, true);
      }
    };
    return window.geniro.onBrowserState((event) => {
      const id = event.state.runId;
      if (event.dockedBack) {
        openColumn(id);
      } else if (event.agentOpenedTabId === null) {
        return;
      } else if (id !== runIdRef.current) {
        markAgentTabUnseen(id);
      } else {
        openColumn(id);
      }
    });
  }, [enabled]);

  // A stable setter, so the controls below change only with the run: the flag's
  // own setter changes identity on every toggle, and every row that reads the
  // pane would re-render with it.
  const showPane = useLatestCallback((value: boolean): void => {
    setOpen(value);
  }, []);
  const openPane = useLatestCallback(
    (tabId: string | null): void => {
      if (runId === null) {
        return;
      }
      clearAgentTabUnseen(runId);
      if (tabId !== null) {
        void window.geniro.browserSelectTab(runId, tabId);
      }
      showPane(true);
    },
    [runId, showPane],
  );
  const openUrl = useLatestCallback(
    (url: string): void => {
      if (runId === null) {
        return;
      }
      void window.geniro.browserOpenTab(runId, url).then(() => {
        clearAgentTabUnseen(runId);
        showPane(true);
      });
    },
    [runId, showPane],
  );
  const isOpen = useLatestCallback((): boolean => openRef.current, []);
  const controls = useMemo(
    () => ({ openPane, openUrl, isOpen }),
    [openPane, openUrl, isOpen],
  );

  return (
    <BrowserPaneContext.Provider value={enabled ? controls : null}>
      <div className={className} style={style}>
        {children}
      </div>
    </BrowserPaneContext.Provider>
  );
}
