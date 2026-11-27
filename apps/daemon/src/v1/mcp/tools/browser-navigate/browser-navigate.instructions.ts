import {
  HOST_BROWSER_CLICK_TOOL,
  HOST_BROWSER_OPEN_TOOL,
} from '../../../agents/chat.types';
import { NEW_HOST, UNTRUSTED } from '../browser-shared/browser-instructions';

/** What a model reads about `browser_navigate`. */
export function browserNavigateInstructions(): string {
  return (
    `Send a tab you already have open to another address; giving its own address reloads it. ` +
    `It answers only once the new page has replaced the old one; when the page's beforeunload handler keeps it (an unsaved-changes guard) the call fails and the old page stays — pass force: true only when that unsaved state may be discarded. ` +
    `Use it when the tab should show a different page than the one it is on, or when a click was refused because it led to a host the user has not approved yet. ` +
    `Do NOT use it to open a page in a new tab (use ${HOST_BROWSER_OPEN_TOOL}) or to follow a link on the page (use ${HOST_BROWSER_CLICK_TOOL}). ` +
    `${NEW_HOST} ${UNTRUSTED}`
  );
}
