import {
  HOST_BROWSER_CLICK_TOOL,
  HOST_BROWSER_SNAPSHOT_TOOL,
} from '../../../agents/chat.types';
import { UNTRUSTED } from '../browser-shared/browser-instructions';

/** What a model reads about `browser_scroll`. */
export function browserScrollInstructions(): string {
  return (
    `Scroll a tab's page, or one scrollable element of it, by a number of pixels. ` +
    `Use it when what you need is further down or up — a lazy-loading list, a long page, a scrollable panel. ` +
    `Do NOT use it to bring an element into view before clicking it — ${HOST_BROWSER_CLICK_TOOL} scrolls to it itself — or to read the page (use ${HOST_BROWSER_SNAPSHOT_TOOL}). ` +
    `${UNTRUSTED}`
  );
}
