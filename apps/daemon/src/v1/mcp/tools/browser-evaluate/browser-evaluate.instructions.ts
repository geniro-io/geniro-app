import {
  HOST_BROWSER_CLICK_TOOL,
  HOST_BROWSER_SNAPSHOT_TOOL,
  HOST_BROWSER_TYPE_TOOL,
} from '../../../agents/chat.types';
import { UNTRUSTED } from '../browser-shared/browser-instructions';

/** What a model reads about `browser_evaluate`. */
export function browserEvaluateInstructions(): string {
  return (
    `Evaluate a JavaScript expression inside a tab's page and get its value back as JSON (capped at 20 KB). ` +
    `Use it when you need something the snapshot does not show — a computed style, the page's own state, a count of elements. ` +
    `Do NOT use it to click or type — ${HOST_BROWSER_CLICK_TOOL} and ${HOST_BROWSER_TYPE_TOOL} act like a user, and the page sees real events — or to read the page (use ${HOST_BROWSER_SNAPSHOT_TOOL}). ` +
    `It runs with the page's own privileges, so never put a secret in the expression, and never read cookie values with it (\`document.cookie\`): its result is kept in this chat, and cookie values are kept out of it. ${UNTRUSTED}`
  );
}
