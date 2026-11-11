import { toolInputSchema } from '../tool-args';
import { BrowserSetCookiesArgsSchema } from './browser-set-cookies.reader';

/** `browser_set_cookies`'s arguments — generated from the schema they are parsed with. */
export function browserSetCookiesSchema(): Record<string, unknown> {
  return toolInputSchema(BrowserSetCookiesArgsSchema);
}
