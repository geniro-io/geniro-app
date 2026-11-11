import {
  HOST_BROWSER_CLEAR_COOKIES_TOOL,
  HOST_BROWSER_SET_COOKIES_TOOL,
} from '../../../agents/chat.types';

/** What a model reads about `browser_get_cookies`. */
export function browserGetCookiesInstructions(): string {
  return (
    `List cookies of the browser — name, domain, path, expiry, flags and the LENGTH of the value, never the value itself. ` +
    `Use it when you need to check that a sign-in or a cookie you set is there and has not expired. ` +
    `Do NOT use it to read a cookie's value: it is never returned, and the page already sends it by itself. To change cookies use ${HOST_BROWSER_SET_COOKIES_TOOL} or ${HOST_BROWSER_CLEAR_COOKIES_TOOL}.`
  );
}
