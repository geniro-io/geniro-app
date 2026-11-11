import { z } from 'zod';

import type { BrowserOp } from '../../../browser/browser.types';
import type { ToolArgs } from '../../mcp.types';
import {
  browserCookiesField,
  browserOptionalTabField,
  readBrowserOp,
} from '../browser-shared/browser-args';

export const BrowserSetCookiesArgsSchema = z.object({
  cookies: browserCookiesField,
  tab: browserOptionalTabField,
});

/** `browser_set_cookies`'s arguments as the operation main runs. */
export function readBrowserSetCookies(
  args: Record<string, unknown>,
): ToolArgs<BrowserOp> {
  return readBrowserOp(
    BrowserSetCookiesArgsSchema,
    args,
    ({ cookies, tab }) => ({
      kind: 'setCookies',
      cookies,
      ...(tab === undefined ? {} : { tab }),
    }),
  );
}
