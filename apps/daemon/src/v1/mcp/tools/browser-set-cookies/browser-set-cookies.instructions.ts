import {
  HOST_BROWSER_GET_COOKIES_TOOL,
  HOST_BROWSER_OPEN_TOOL,
  HOST_BROWSER_TYPE_TOOL,
} from '../../../agents/chat.types';

/** What a model reads about `browser_set_cookies`. */
export function browserSetCookiesInstructions(): string {
  return (
    `Put cookies into the browser: into this chat's own cookie jar, or into the in-memory cookies of a tab opened with \`ownCookies\` when \`tab\` names it. ` +
    `Use it when the user gave you a session cookie or token to get past a sign-in, or a page needs a cookie set — a feature flag, a consent choice. ` +
    `Values go in as given and are never shown back to anyone; cookies set in the chat's jar stay for the later pages of this chat. ` +
    `Check the result with ${HOST_BROWSER_GET_COOKIES_TOOL}. ` +
    `Do NOT use it to sign in through the page's own form (use ${HOST_BROWSER_TYPE_TOOL}), or to get a second identity beside the first (use ${HOST_BROWSER_OPEN_TOOL} with \`ownCookies\`).`
  );
}
