import { toolInputSchema } from '../tool-args';
import { BrowserTabsArgsSchema } from './browser-tabs.reader';

/** `browser_tabs`'s arguments — generated from the schema they are parsed with. */
export function browserTabsSchema(): Record<string, unknown> {
  return toolInputSchema(BrowserTabsArgsSchema);
}
