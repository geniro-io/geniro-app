import { z } from 'zod';

import {
  BROWSER_VIEWPORT_MAX_HEIGHT,
  BROWSER_VIEWPORT_MAX_WIDTH,
  BROWSER_VIEWPORT_MIN,
  type BrowserOp,
} from '../../../browser/browser.types';
import type { ToolArgs } from '../../mcp.types';
import { browserTabField, readBrowserOp } from '../browser-shared/browser-args';

export const BrowserScreenshotArgsSchema = z.object({
  tab: browserTabField,
  fullPage: z
    .boolean()
    .default(false)
    .describe(
      'Capture the whole scroll height of the page instead of the visible part.',
    ),
  view: z
    .boolean()
    .default(false)
    .describe(
      'Also put the picture into this result so you can look at it yourself (at CSS-pixel size). Leave it out when you only need the saved file — to show the user or to compare later; reading the file shows it to you too.',
    ),
  width: z
    .number()
    .int()
    .min(BROWSER_VIEWPORT_MIN)
    .max(BROWSER_VIEWPORT_MAX_WIDTH)
    .optional()
    .describe(
      'Take the shot as if the window were this many CSS pixels wide (e.g. 1440), whatever size the browser pane is; the page goes back to its own size afterwards.',
    ),
  height: z
    .number()
    .int()
    .min(BROWSER_VIEWPORT_MIN)
    .max(BROWSER_VIEWPORT_MAX_HEIGHT)
    .optional()
    .describe(
      'Take the shot as if the window were this many CSS pixels tall (e.g. 1280); with `width` it sets the whole window size.',
    ),
});

/** `browser_screenshot`'s arguments as the operation main runs. */
export function readBrowserScreenshot(
  args: Record<string, unknown>,
): ToolArgs<BrowserOp> {
  return readBrowserOp(
    BrowserScreenshotArgsSchema,
    args,
    ({ tab, fullPage, view, width, height }) => ({
      kind: 'screenshot',
      tab,
      fullPage,
      view,
      ...(width === undefined ? {} : { width }),
      ...(height === undefined ? {} : { height }),
    }),
  );
}
