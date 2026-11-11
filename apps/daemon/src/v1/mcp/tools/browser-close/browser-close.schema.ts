import { toolInputSchema } from '../tool-args';
import { BrowserCloseArgsSchema } from './browser-close.reader';

/** `browser_close`'s arguments — generated from the schema they are parsed with. */
export function browserCloseSchema(): Record<string, unknown> {
  return toolInputSchema(BrowserCloseArgsSchema);
}
