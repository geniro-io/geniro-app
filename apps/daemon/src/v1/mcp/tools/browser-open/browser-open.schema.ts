import { toolInputSchema } from '../tool-args';
import { BrowserOpenArgsSchema } from './browser-open.reader';

/** `browser_open`'s arguments — generated from the schema they are parsed with. */
export function browserOpenSchema(): Record<string, unknown> {
  return toolInputSchema(BrowserOpenArgsSchema);
}
