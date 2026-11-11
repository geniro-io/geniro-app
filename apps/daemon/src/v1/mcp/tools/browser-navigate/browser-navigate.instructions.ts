import {
  HOST_BROWSER_CLICK_TOOL,
  HOST_BROWSER_OPEN_TOOL,
} from '../../../agents/chat.types';
import { NEW_HOST, UNTRUSTED } from '../browser-shared/browser-instructions';

/** What a model reads about `browser_navigate`. */
export function browserNavigateInstructions(): string {
  return (
    `Send a tab you already have open to another address; giving its own address reloads it. ` +
    `Use it when the tab should show a different page than the one it is on, or when a click was refused because it led to a host the user has not approved yet. ` +
    `Do NOT use it to open a page in a new tab (use ${HOST_BROWSER_OPEN_TOOL}) or to follow a link on the page (use ${HOST_BROWSER_CLICK_TOOL}). ` +
    `${NEW_HOST} ${UNTRUSTED}`
  );
}
