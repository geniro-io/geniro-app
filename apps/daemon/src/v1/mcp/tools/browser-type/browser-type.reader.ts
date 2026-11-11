import { z } from 'zod';

import type { BrowserOp } from '../../../browser/browser.types';
import type { ToolArgs } from '../../mcp.types';
import {
  browserRefField,
  browserTabField,
  readBrowserOp,
} from '../browser-shared/browser-args';

export const BrowserTypeArgsSchema = z.object({
  tab: browserTabField,
  ref: browserRefField,
  text: z.string().max(10000).describe('The text to type into the field.'),
  submit: z
    .boolean()
    .default(false)
    .describe('Press Enter after typing — to submit a form or a search.'),
});

/** `browser_type`'s arguments as the operation main runs. */
export function readBrowserType(
  args: Record<string, unknown>,
): ToolArgs<BrowserOp> {
  return readBrowserOp(
    BrowserTypeArgsSchema,
    args,
    ({ tab, ref, text, submit }) => ({ kind: 'type', tab, ref, text, submit }),
  );
}
