import { toolInputSchema } from '../tool-args';
import { BrowserScrollArgsSchema } from './browser-scroll.reader';

/** `browser_scroll`'s arguments — generated from the schema they are parsed with. */
export function browserScrollSchema(): Record<string, unknown> {
  return toolInputSchema(BrowserScrollArgsSchema);
}
