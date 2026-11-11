import { toolInputSchema } from '../tool-args';
import { BrowserScreenshotArgsSchema } from './browser-screenshot.reader';

/** `browser_screenshot`'s arguments — generated from the schema they are parsed with. */
export function browserScreenshotSchema(): Record<string, unknown> {
  return toolInputSchema(BrowserScreenshotArgsSchema);
}
