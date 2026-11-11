import {
  HOST_BROWSER_NAVIGATE_TOOL,
  HOST_BROWSER_SELECT_TOOL,
  HOST_BROWSER_SNAPSHOT_TOOL,
  HOST_BROWSER_TYPE_TOOL,
} from '../../../agents/chat.types';
import { REFS, UNTRUSTED } from '../browser-shared/browser-instructions';

/** What a model reads about `browser_click`. */
export function browserClickInstructions(): string {
  return (
    `Click an element of a tab by its ref from the latest ${HOST_BROWSER_SNAPSHOT_TOOL}: a link, a button, a checkbox, a tab. ` +
    `Use it when the next step on the page is a click. ${REFS} ` +
    `Do NOT use it to fill a text field (use ${HOST_BROWSER_TYPE_TOOL}) or to choose from a dropdown (use ${HOST_BROWSER_SELECT_TOOL}); to go to an address directly use ${HOST_BROWSER_NAVIGATE_TOOL}. ` +
    `A click that leads to a host the user has not approved is refused until you go there with ${HOST_BROWSER_NAVIGATE_TOOL}. ${UNTRUSTED}`
  );
}
