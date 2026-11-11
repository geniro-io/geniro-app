import { z } from 'zod';

import type { BrowserOp } from '../../../browser/browser.types';
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
});

/** `browser_screenshot`'s arguments as the operation main runs. */
export function readBrowserScreenshot(
  args: Record<string, unknown>,
): ToolArgs<BrowserOp> {
  return readBrowserOp(
    BrowserScreenshotArgsSchema,
    args,
    ({ tab, fullPage }) => ({ kind: 'screenshot', tab, fullPage }),
  );
}
