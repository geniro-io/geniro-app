import { toolInputSchema } from '../tool-args';
import { BrowserLabelTabArgsSchema } from './browser-label-tab.reader';

/** `browser_label_tab`'s arguments — generated from the schema they are parsed with. */
export function browserLabelTabSchema(): Record<string, unknown> {
  return toolInputSchema(BrowserLabelTabArgsSchema);
}
