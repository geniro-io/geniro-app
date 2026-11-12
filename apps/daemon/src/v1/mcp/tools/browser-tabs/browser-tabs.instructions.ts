import {
  HOST_BROWSER_LABEL_TAB_TOOL,
  HOST_BROWSER_OPEN_TOOL,
  HOST_BROWSER_SNAPSHOT_TOOL,
} from '../../../agents/chat.types';
import { UNTRUSTED } from '../browser-shared/browser-instructions';

/** What a model reads about `browser_tabs`. */
export function browserTabsInstructions(): string {
  return (
    `List this chat's open tabs: id, name and colour, title, address, which one is active, and the label of a tab opened with its own cookies. ` +
    `Use it when you lost a tab id, or to see which tabs the user opened themselves. ` +
    `Do NOT use it to read a page (use ${HOST_BROWSER_SNAPSHOT_TOOL}), to open one (use ${HOST_BROWSER_OPEN_TOOL}) or to rename one (use ${HOST_BROWSER_LABEL_TAB_TOOL}). ` +
    `${UNTRUSTED}`
  );
}
