import { z } from 'zod';

import type { BrowserOp } from '../../../browser/browser.types';
import type { ToolArgs } from '../../mcp.types';
import {
  browserRefField,
  browserTabField,
  readBrowserOp,
} from '../browser-shared/browser-args';

export const BrowserSelectArgsSchema = z.object({
  tab: browserTabField,
  ref: browserRefField,
  values: z
    .array(z.string().max(1000))
    .min(1)
    .max(50)
    .describe(
      'The option value(s) or visible label(s) to choose; several only for a multi-select.',
    ),
});

/** `browser_select`'s arguments as the operation main runs. */
export function readBrowserSelect(
  args: Record<string, unknown>,
): ToolArgs<BrowserOp> {
  return readBrowserOp(
    BrowserSelectArgsSchema,
    args,
    ({ tab, ref, values }) => ({ kind: 'select', tab, ref, values }),
  );
}
