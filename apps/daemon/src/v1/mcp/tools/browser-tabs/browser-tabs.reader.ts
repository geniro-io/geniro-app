import { z } from 'zod';

import type { BrowserOp } from '../../../browser/browser.types';
import type { ToolArgs } from '../../mcp.types';
import { readBrowserOp } from '../browser-shared/browser-args';

export const BrowserTabsArgsSchema = z.object({});

/** `browser_tabs`'s arguments as the operation main runs. */
export function readBrowserTabs(
  args: Record<string, unknown>,
): ToolArgs<BrowserOp> {
  return readBrowserOp(BrowserTabsArgsSchema, args, () => ({ kind: 'tabs' }));
}
