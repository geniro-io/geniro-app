import { z } from 'zod';

import type { BrowserOp } from '../../../browser/browser.types';
import type { ToolArgs } from '../../mcp.types';
import { browserTabField, readBrowserOp } from '../browser-shared/browser-args';

export const BrowserSnapshotArgsSchema = z.object({
  tab: browserTabField,
  interactive: z
    .boolean()
    .default(false)
    .describe(
      'List only the elements you can act on (links, buttons, fields, options), each with its ref — the smallest snapshot, for finding what to click or type into.',
    ),
  text: z
    .boolean()
    .default(false)
    .describe(
      'Also return the page’s visible text (paragraphs, messages, table contents). Leave it out when the element list is enough; it is the largest part of a snapshot.',
    ),
});

/** `browser_snapshot`'s arguments as the operation main runs. */
export function readBrowserSnapshot(
  args: Record<string, unknown>,
): ToolArgs<BrowserOp> {
  return readBrowserOp(
    BrowserSnapshotArgsSchema,
    args,
    ({ tab, interactive, text }) => ({
      kind: 'snapshot',
      tab,
      interactive,
      text,
    }),
  );
}
