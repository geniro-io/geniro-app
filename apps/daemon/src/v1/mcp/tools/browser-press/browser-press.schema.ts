import { toolInputSchema } from '../tool-args';
import { BrowserPressArgsSchema } from './browser-press.reader';

/** `browser_press`'s arguments — generated from the schema they are parsed with. */
export function browserPressSchema(): Record<string, unknown> {
  return toolInputSchema(BrowserPressArgsSchema);
}
