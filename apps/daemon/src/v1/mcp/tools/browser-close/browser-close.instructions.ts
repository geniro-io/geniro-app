import { HOST_BROWSER_NAVIGATE_TOOL } from '../../../agents/chat.types';

/** What a model reads about `browser_close`. */
export function browserCloseInstructions(): string {
  return (
    `Close a tab. ` +
    `Use it when you are done with a tab you opened, so the user's pane is not left with a stack of pages. ` +
    `Do NOT close a tab the user opened themselves unless they asked you to, and do NOT use it to leave a page for another (use ${HOST_BROWSER_NAVIGATE_TOOL}). ` +
    `Closing a tab opened with its own cookies discards those cookies.`
  );
}
