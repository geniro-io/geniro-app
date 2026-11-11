import {
  HOST_BROWSER_GET_COOKIES_TOOL,
  HOST_BROWSER_SET_COOKIES_TOOL,
} from '../../../agents/chat.types';

/** What a model reads about `browser_clear_cookies`. */
export function browserClearCookiesInstructions(): string {
  return (
    `Delete cookies from the browser: all of them, or one domain's, in this chat's jar or in a tab opened with its own cookies. ` +
    `Use it when you need a signed-out state or a clean retry. ` +
    `Do NOT use it casually: clearing the chat's jar also signs the user out of everything they logged in to in this chat's browser. To set cookies use ${HOST_BROWSER_SET_COOKIES_TOOL}; to look at them ${HOST_BROWSER_GET_COOKIES_TOOL}.`
  );
}
