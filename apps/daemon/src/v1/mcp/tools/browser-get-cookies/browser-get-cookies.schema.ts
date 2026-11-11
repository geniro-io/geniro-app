import { toolInputSchema } from '../tool-args';
import { BrowserGetCookiesArgsSchema } from './browser-get-cookies.reader';

/** `browser_get_cookies`'s arguments — generated from the schema they are parsed with. */
export function browserGetCookiesSchema(): Record<string, unknown> {
  return toolInputSchema(BrowserGetCookiesArgsSchema);
}
