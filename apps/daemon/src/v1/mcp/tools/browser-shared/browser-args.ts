import { z } from 'zod';

import type { BrowserOp } from '../../../browser/browser.types';
import type { ToolArgs } from '../../mcp.types';
import { readToolArgs } from '../tool-args';

export const MAX_BROWSER_COOKIES = 50;

export const browserTabField = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .describe(
    'The tab to act on, as browser_open or browser_tabs named it (t1, t2, …).',
  );

export const browserOptionalTabField = browserTabField
  .optional()
  .describe(
    'A tab opened with `ownCookies`, to act on that tab’s own cookies. Leave it out for this chat’s own cookies.',
  );

export const browserRefField = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .describe(
    'An element ref (e12) from the latest browser_snapshot of this tab.',
  );

export const browserUrlField = z.string().trim().min(1).max(2048);

export const BrowserCookieSchema = z
  .object({
    name: z.string().min(1).max(256).describe('The cookie’s name.'),
    value: z
      .string()
      .max(4096)
      .describe(
        'The cookie’s value. It goes into the browser and is never shown back to anyone, so it can be a login.',
      ),
    url: z
      .string()
      .trim()
      .min(1)
      .max(2048)
      .optional()
      .describe(
        'The page address the cookie belongs to. Give this or `domain`.',
      ),
    domain: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .optional()
      .describe(
        'The domain the cookie belongs to (a leading dot covers subdomains). Give this or `url`.',
      ),
    path: z.string().max(2048).optional().describe('The cookie’s path.'),
    secure: z.boolean().optional().describe('Send only over https.'),
    httpOnly: z.boolean().optional().describe('Hide it from page scripts.'),
    sameSite: z
      .enum(['unspecified', 'no_restriction', 'lax', 'strict'])
      .optional()
      .describe('The SameSite policy.'),
    expires: z
      .number()
      .optional()
      .describe(
        'Expiry in seconds since the epoch. Leave it out for a session cookie.',
      ),
  })
  .strict()
  .refine((cookie) => cookie.url !== undefined || cookie.domain !== undefined, {
    message: 'a cookie needs a `url` or a `domain`',
  });

export const browserCookiesField = z
  .array(BrowserCookieSchema)
  .min(1)
  .max(MAX_BROWSER_COOKIES);

/** A browser tool's arguments read with its strict schema, then turned into the operation it asks of main. */
export function readBrowserOp<TArgs extends z.ZodObject>(
  schema: TArgs,
  args: Record<string, unknown>,
  toOp: (parsed: z.infer<TArgs>) => BrowserOp,
): ToolArgs<BrowserOp> {
  const read = readToolArgs(schema.strict(), args);
  return read.ok
    ? { ok: true, query: toOp(read.query as z.infer<TArgs>) }
    : read;
}
