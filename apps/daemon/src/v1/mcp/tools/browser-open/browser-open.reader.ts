import { z } from 'zod';

import type { BrowserOp } from '../../../browser/browser.types';
import type { ToolArgs } from '../../mcp.types';
import {
  browserCookiesField,
  browserUrlField,
  readBrowserOp,
} from '../browser-shared/browser-args';

export const BrowserOpenArgsSchema = z.object({
  url: browserUrlField.describe(
    'The page to open, as an http(s) address — a preview stand, a staging site, a docs page. localhost addresses work.',
  ),
  ownCookies: z
    .object({
      label: z
        .string()
        .trim()
        .min(1)
        .max(60)
        .describe(
          'A short name for this tab’s identity, shown on the tab — e.g. "admin" or "customer".',
        ),
      cookies: browserCookiesField,
    })
    .strict()
    .optional()
    .describe(
      'Open the tab with ITS OWN in-memory cookies instead of this chat’s: they are set before the first load and vanish with the tab, so two tabs can be signed in as two users at once.',
    ),
});

/** `browser_open`'s arguments as the operation main runs. */
export function readBrowserOpen(
  args: Record<string, unknown>,
): ToolArgs<BrowserOp> {
  return readBrowserOp(BrowserOpenArgsSchema, args, ({ url, ownCookies }) => ({
    kind: 'open',
    url,
    ...(ownCookies === undefined ? {} : { ownCookies }),
  }));
}
