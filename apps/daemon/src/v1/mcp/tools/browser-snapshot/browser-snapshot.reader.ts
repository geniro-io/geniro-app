import { z } from 'zod';

import type { BrowserOp } from '../../../browser/browser.types';
import type { ToolArgs } from '../../mcp.types';
import { browserTabField, readBrowserOp } from '../browser-shared/browser-args';

export const BrowserSnapshotArgsSchema = z.object({
  tab: browserTabField,
});

/** `browser_snapshot`'s arguments as the operation main runs. */
export function readBrowserSnapshot(
  args: Record<string, unknown>,
): ToolArgs<BrowserOp> {
  return readBrowserOp(BrowserSnapshotArgsSchema, args, ({ tab }) => ({
    kind: 'snapshot',
    tab,
  }));
}
