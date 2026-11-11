import { z } from 'zod';

import type { BrowserOp } from '../../../browser/browser.types';
import type { ToolArgs } from '../../mcp.types';
import {
  browserOptionalTabField,
  readBrowserOp,
} from '../browser-shared/browser-args';

export const BrowserGetCookiesArgsSchema = z.object({
  url: z
    .string()
    .trim()
    .min(1)
    .max(2048)
    .optional()
    .describe(
      'Only the cookies a request to this address would send. Leave it out for all of them.',
    ),
  tab: browserOptionalTabField,
});

/** `browser_get_cookies`'s arguments as the operation main runs. */
export function readBrowserGetCookies(
  args: Record<string, unknown>,
): ToolArgs<BrowserOp> {
  return readBrowserOp(BrowserGetCookiesArgsSchema, args, ({ url, tab }) => ({
    kind: 'getCookies',
    ...(tab === undefined ? {} : { tab }),
    ...(url === undefined ? {} : { url }),
  }));
}
