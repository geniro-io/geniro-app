import {
  HOST_BROWSER_EVALUATE_TOOL,
  HOST_BROWSER_SNAPSHOT_TOOL,
} from '../../../agents/chat.types';
import { UNTRUSTED } from '../browser-shared/browser-instructions';

/** What a model reads about `browser_console`. */
export function browserConsoleInstructions(): string {
  return (
    `Read the most recent console messages and uncaught errors of a tab (the last 200). ` +
    `Use it when debugging a page: a blank screen, an action that did nothing, a failed request, a script error. ` +
    `Do NOT use it to see what the page shows (use ${HOST_BROWSER_SNAPSHOT_TOOL}) or to run code in the page (use ${HOST_BROWSER_EVALUATE_TOOL}). ` +
    `${UNTRUSTED}`
  );
}
