import { z } from 'zod';

import type { BrowserOp } from '../../../browser/browser.types';
import type { ToolArgs } from '../../mcp.types';
import { browserTabField, readBrowserOp } from '../browser-shared/browser-args';

export const BrowserCloseArgsSchema = z.object({
  tab: browserTabField,
});

/** `browser_close`'s arguments as the operation main runs. */
export function readBrowserClose(
  args: Record<string, unknown>,
): ToolArgs<BrowserOp> {
  return readBrowserOp(BrowserCloseArgsSchema, args, ({ tab }) => ({
    kind: 'close',
    tab,
  }));
}
