import { z } from 'zod';

import type { BrowserOp } from '../../../browser/browser.types';
import type { ToolArgs } from '../../mcp.types';
import { browserTabField, readBrowserOp } from '../browser-shared/browser-args';

export const BrowserConsoleArgsSchema = z.object({
  tab: browserTabField,
});

/** `browser_console`'s arguments as the operation main runs. */
export function readBrowserConsole(
  args: Record<string, unknown>,
): ToolArgs<BrowserOp> {
  return readBrowserOp(BrowserConsoleArgsSchema, args, ({ tab }) => ({
    kind: 'console',
    tab,
  }));
}
