import { z } from 'zod';

import type { BrowserOp } from '../../../browser/browser.types';
import type { ToolArgs } from '../../mcp.types';
import {
  browserRefField,
  browserTabField,
  readBrowserOp,
} from '../browser-shared/browser-args';

export const BrowserClickArgsSchema = z.object({
  tab: browserTabField,
  ref: browserRefField,
});

/** `browser_click`'s arguments as the operation main runs. */
export function readBrowserClick(
  args: Record<string, unknown>,
): ToolArgs<BrowserOp> {
  return readBrowserOp(BrowserClickArgsSchema, args, ({ tab, ref }) => ({
    kind: 'click',
    tab,
    ref,
  }));
}
