import { toolInputSchema } from '../tool-args';
import { BrowserNavigateArgsSchema } from './browser-navigate.reader';

/** `browser_navigate`'s arguments — generated from the schema they are parsed with. */
export function browserNavigateSchema(): Record<string, unknown> {
  return toolInputSchema(BrowserNavigateArgsSchema);
}
