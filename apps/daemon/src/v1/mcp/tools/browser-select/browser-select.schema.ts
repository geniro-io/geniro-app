import { toolInputSchema } from '../tool-args';
import { BrowserSelectArgsSchema } from './browser-select.reader';

/** `browser_select`'s arguments — generated from the schema they are parsed with. */
export function browserSelectSchema(): Record<string, unknown> {
  return toolInputSchema(BrowserSelectArgsSchema);
}
