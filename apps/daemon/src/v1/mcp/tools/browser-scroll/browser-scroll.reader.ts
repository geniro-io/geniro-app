import { z } from 'zod';

import type { BrowserOp } from '../../../browser/browser.types';
import type { ToolArgs } from '../../mcp.types';
import {
  browserRefField,
  browserTabField,
  readBrowserOp,
} from '../browser-shared/browser-args';

export const BrowserScrollArgsSchema = z.object({
  tab: browserTabField,
  ref: browserRefField
    .optional()
    .describe('Scroll this element instead of the page.'),
  dy: z
    .number()
    .min(-100000)
    .max(100000)
    .optional()
    .describe(
      'Pixels to scroll: positive is down, negative is up. Leave it out to scroll one screen down.',
    ),
});

/** `browser_scroll`'s arguments as the operation main runs. */
export function readBrowserScroll(
  args: Record<string, unknown>,
): ToolArgs<BrowserOp> {
  return readBrowserOp(BrowserScrollArgsSchema, args, ({ tab, ref, dy }) => ({
    kind: 'scroll',
    tab,
    ...(ref === undefined ? {} : { ref }),
    ...(dy === undefined ? {} : { dy }),
  }));
}
