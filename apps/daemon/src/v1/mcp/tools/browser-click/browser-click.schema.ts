import { toolInputSchema } from '../tool-args';
import { BrowserClickArgsSchema } from './browser-click.reader';

/** `browser_click`'s arguments — generated from the schema they are parsed with. */
export function browserClickSchema(): Record<string, unknown> {
  return toolInputSchema(BrowserClickArgsSchema);
}
