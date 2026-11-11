import { toolInputSchema } from '../tool-args';
import { BrowserTypeArgsSchema } from './browser-type.reader';

/** `browser_type`'s arguments — generated from the schema they are parsed with. */
export function browserTypeSchema(): Record<string, unknown> {
  return toolInputSchema(BrowserTypeArgsSchema);
}
