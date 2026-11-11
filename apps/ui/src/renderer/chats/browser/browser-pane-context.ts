import { createContext, useContext } from 'react';

/** What the open chat's browser pane offers the rows drawn beside it. */
export interface BrowserPaneControls {
  /** Show the pane, on this tab when one is named. */
  openPane(tabId: string | null): void;
  /** Open an address in a new tab of this chat's browser and show the pane. */
  openUrl(url: string): void;
}

/** Null where no chat browser exists: a paired device, a surface without a run. */
export const BrowserPaneContext = createContext<BrowserPaneControls | null>(
  null,
);

export function useBrowserPane(): BrowserPaneControls | null {
  return useContext(BrowserPaneContext);
}
