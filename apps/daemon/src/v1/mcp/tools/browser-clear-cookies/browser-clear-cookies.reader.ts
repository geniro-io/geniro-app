import { z } from 'zod';

import type { BrowserOp } from '../../../browser/browser.types';
import type { ToolArgs } from '../../mcp.types';
import {
  browserOptionalTabField,
  readBrowserOp,
} from '../browser-shared/browser-args';

export const BrowserClearCookiesArgsSchema = z.object({
  domain: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .optional()
    .describe(
      'Only the cookies of this domain. Leave it out to clear them all.',
    ),
  tab: browserOptionalTabField,
});

/** `browser_clear_cookies`'s arguments as the operation main runs. */
export function readBrowserClearCookies(
  args: Record<string, unknown>,
): ToolArgs<BrowserOp> {
  return readBrowserOp(
    BrowserClearCookiesArgsSchema,
    args,
    ({ domain, tab }) => ({
      kind: 'clearCookies',
      ...(tab === undefined ? {} : { tab }),
      ...(domain === undefined ? {} : { domain }),
    }),
  );
}
