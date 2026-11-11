import { z } from 'zod';

/**
 * One operation an agent asks of a chat's in-app browser, relayed by the
 * renderer from the daemon's `browser_request`.
 *
 * TWIN PARSER: `apps/daemon/src/v1/browser/browser.types.ts` (`BrowserOp`,
 * `BrowserRequest`, `BrowserReplySchema`).
 */
const cookieSchema = z.strictObject({
  name: z.string().min(1).max(4096),
  value: z.string().max(16_384),
  url: z.string().max(4096).optional(),
  domain: z.string().max(1024).optional(),
  path: z.string().max(4096).optional(),
  secure: z.boolean().optional(),
  httpOnly: z.boolean().optional(),
  sameSite: z
    .enum(['unspecified', 'no_restriction', 'lax', 'strict'])
    .optional(),
  expires: z.number().finite().optional(),
});

const tab = z.string().min(1).max(128);
const ref = z.string().min(1).max(32);

export const browserOpSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('open'),
    url: z.string().min(1).max(8192),
    ownCookies: z
      .strictObject({
        label: z.string().min(1).max(64),
        cookies: z.array(cookieSchema).max(200),
      })
      .optional(),
  }),
  z.strictObject({
    kind: z.literal('navigate'),
    tab,
    url: z.string().min(1).max(8192),
  }),
  z.strictObject({ kind: z.literal('snapshot'), tab }),
  z.strictObject({ kind: z.literal('click'), tab, ref }),
  z.strictObject({
    kind: z.literal('type'),
    tab,
    ref,
    text: z.string().max(65_536),
    submit: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal('press'),
    tab,
    key: z.string().min(1).max(64),
  }),
  z.strictObject({
    kind: z.literal('select'),
    tab,
    ref,
    values: z.array(z.string().max(4096)).max(100),
  }),
  z.strictObject({
    kind: z.literal('scroll'),
    tab,
    ref: ref.optional(),
    dy: z.number().finite().optional(),
  }),
  z.strictObject({ kind: z.literal('screenshot'), tab, fullPage: z.boolean() }),
  z.strictObject({ kind: z.literal('console'), tab }),
  z.strictObject({
    kind: z.literal('evaluate'),
    tab,
    expression: z.string().min(1).max(65_536),
  }),
  z.strictObject({ kind: z.literal('tabs') }),
  z.strictObject({ kind: z.literal('close'), tab }),
  z.strictObject({
    kind: z.literal('setCookies'),
    tab: tab.optional(),
    cookies: z.array(cookieSchema).min(1).max(200),
  }),
  z.strictObject({
    kind: z.literal('getCookies'),
    tab: tab.optional(),
    url: z.string().max(8192).optional(),
  }),
  z.strictObject({
    kind: z.literal('clearCookies'),
    tab: tab.optional(),
    domain: z.string().max(1024).optional(),
  }),
]);

export type BrowserOp = z.infer<typeof browserOpSchema>;
export type BrowserCookieInput = z.infer<typeof cookieSchema>;

export const browserRequestSchema = z.strictObject({
  id: z.string().min(1).max(128),
  runId: z.string().min(1).max(128),
  memberName: z.string().max(256),
  op: browserOpSchema,
  allowedHosts: z.array(z.string().max(1024)).nullable(),
});

export type BrowserRequest = z.infer<typeof browserRequestSchema>;

export type BrowserReply =
  | { id: string; ok: true; text: string; png?: string; tab?: string }
  | { id: string; ok: false; error: string };

/**
 * The most base64 a screenshot reply may carry. TWIN: `BROWSER_REPLY_MAX_BYTES`
 * in `apps/daemon/src/v1/browser/browser.types.ts`, the socket's message ceiling,
 * of which this leaves headroom for the rest of the reply.
 */
export const BROWSER_SCREENSHOT_MAX_BASE64 = 12 * 1024 * 1024;
