import { z } from 'zod';

import type { BrowserOp } from '../../../browser/browser.types';
import type { ToolArgs } from '../../mcp.types';
import { browserTabField, readBrowserOp } from '../browser-shared/browser-args';

export const BrowserEvaluateArgsSchema = z.object({
  tab: browserTabField,
  expression: z
    .string()
    .trim()
    .min(1)
    .max(20000)
    .describe(
      'A JavaScript expression evaluated in the page; its value comes back as JSON, capped at 20 KB.',
    ),
});

/** `browser_evaluate`'s arguments as the operation main runs. */
export function readBrowserEvaluate(
  args: Record<string, unknown>,
): ToolArgs<BrowserOp> {
  return readBrowserOp(
    BrowserEvaluateArgsSchema,
    args,
    ({ tab, expression }) => ({ kind: 'evaluate', tab, expression }),
  );
}
