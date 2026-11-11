import { toolInputSchema } from '../tool-args';
import { BrowserConsoleArgsSchema } from './browser-console.reader';

/** `browser_console`'s arguments — generated from the schema they are parsed with. */
export function browserConsoleSchema(): Record<string, unknown> {
  return toolInputSchema(BrowserConsoleArgsSchema);
}
