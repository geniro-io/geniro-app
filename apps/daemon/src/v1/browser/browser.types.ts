import { z } from 'zod';

/** How long the daemon waits on the desktop window for one browser operation. */
export const BROWSER_REQUEST_TIMEOUT_MS = 20_000;

/**
 * The largest socket message the daemon takes, sized for a `browser_reply`
 * carrying a screenshot; socket.io's 1 MB default would drop the connection.
 * TWIN: `BROWSER_SCREENSHOT_MAX_BASE64` in `apps/ui/src/main/browser/browser-agent-wire.ts` stays below it.
 */
export const BROWSER_REPLY_MAX_BYTES = 16 * 1024 * 1024;

/** One cookie an agent puts into a browser jar. */
export interface BrowserCookieInput {
  name: string;
  value: string;
  url?: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: 'unspecified' | 'no_restriction' | 'lax' | 'strict';
  /** Seconds since the epoch; absent is a session cookie. */
  expires?: number;
}

/**
 * One operation an agent asks of a chat's in-app browser, as it travels to
 * the desktop window. TWIN PARSER: `apps/ui/src/main/browser/browser-agent-wire.ts`.
 */
export type BrowserOp =
  | {
      kind: 'open';
      url: string;
      ownCookies?: { label: string; cookies: BrowserCookieInput[] };
    }
  | { kind: 'navigate'; tab: string; url: string }
  | { kind: 'snapshot'; tab: string }
  | { kind: 'click'; tab: string; ref: string }
  | { kind: 'type'; tab: string; ref: string; text: string; submit: boolean }
  | { kind: 'press'; tab: string; key: string }
  | { kind: 'select'; tab: string; ref: string; values: string[] }
  | { kind: 'scroll'; tab: string; ref?: string; dy?: number }
  | { kind: 'screenshot'; tab: string; fullPage: boolean }
  | { kind: 'console'; tab: string }
  | { kind: 'evaluate'; tab: string; expression: string }
  | { kind: 'tabs' }
  | { kind: 'close'; tab: string }
  | { kind: 'setCookies'; tab?: string; cookies: BrowserCookieInput[] }
  | { kind: 'getCookies'; tab?: string; url?: string }
  | { kind: 'clearCookies'; tab?: string; domain?: string };

export type BrowserOpKind = BrowserOp['kind'];

/**
 * `browser_request`: daemon → the registered desktop socket.
 *
 * `allowedHosts` is the set a navigation the operation causes may reach
 * without the user's approval; null means any (the chat is in `auto`, or the
 * user allowed every host for this session).
 */
export interface BrowserRequest {
  id: string;
  runId: string;
  memberName: string;
  op: BrowserOp;
  allowedHosts: string[] | null;
}

/** TWIN PARSER: `apps/ui/src/main/browser/browser-agent-wire.ts`. */
export const BrowserReplySchema = z.union([
  z.strictObject({
    id: z.string().min(1),
    ok: z.literal(true),
    text: z.string(),
    png: z.string().optional(),
    tab: z.string().optional(),
  }),
  z.strictObject({
    id: z.string().min(1),
    ok: z.literal(false),
    error: z.string(),
  }),
]);

/** `browser_reply`: the desktop socket → daemon. */
export type BrowserReply = z.infer<typeof BrowserReplySchema>;

/** What a bridge request ended as, for the tool to word. */
export type BrowserOutcome =
  | { status: 'done'; text: string; png?: string; tab?: string }
  | { status: 'failed'; reason: string };
