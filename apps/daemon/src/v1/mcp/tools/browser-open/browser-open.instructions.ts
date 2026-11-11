import {
  HOST_BROWSER_NAVIGATE_TOOL,
  HOST_BROWSER_SNAPSHOT_TOOL,
} from '../../../agents/chat.types';
import { NEW_HOST, UNTRUSTED } from '../browser-shared/browser-instructions';

/** What a model reads about `browser_open`. */
export function browserOpenInstructions(): string {
  return (
    `Open a page in a NEW tab of the in-app browser beside this chat, and get the tab's id (t1, t2, …) back. ` +
    `Use it when you need to see or drive a web page the way the user would, with them watching in the pane: a preview stand or staging site, a docs page, a sign-in flow. ` +
    `Every chat has its own tabs and its own cookie jar, so a login done earlier in this chat is still there. ` +
    `Pass \`ownCookies\` (a label and cookies) to open the tab with its OWN in-memory cookies instead of the chat's — for example to sign in as two different users in two tabs; those cookies never touch the chat's jar. ` +
    `Read the page next with ${HOST_BROWSER_SNAPSHOT_TOOL}. ` +
    `Do NOT use it to move an existing tab to another address (use ${HOST_BROWSER_NAVIGATE_TOOL}), or to fetch an API or download a file (use your shell instead). ` +
    `${NEW_HOST} ${UNTRUSTED}`
  );
}
