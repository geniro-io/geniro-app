import { z } from 'zod';

import type { BrowserOp } from '../../../browser/browser.types';
import type { ToolArgs } from '../../mcp.types';
import { browserTabField, readBrowserOp } from '../browser-shared/browser-args';

export const BrowserPressArgsSchema = z.object({
  tab: browserTabField,
  key: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .describe(
      'The key or chord: Enter, Escape, Tab, ArrowDown, Control+A, Shift+Tab.',
    ),
});

/** `browser_press`'s arguments as the operation main runs. */
export function readBrowserPress(
  args: Record<string, unknown>,
): ToolArgs<BrowserOp> {
  return readBrowserOp(BrowserPressArgsSchema, args, ({ tab, key }) => ({
    kind: 'press',
    tab,
    key,
  }));
}
