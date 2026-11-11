import { toolInputSchema } from '../tool-args';
import { BrowserClearCookiesArgsSchema } from './browser-clear-cookies.reader';

/** `browser_clear_cookies`'s arguments — generated from the schema they are parsed with. */
export function browserClearCookiesSchema(): Record<string, unknown> {
  return toolInputSchema(BrowserClearCookiesArgsSchema);
}
