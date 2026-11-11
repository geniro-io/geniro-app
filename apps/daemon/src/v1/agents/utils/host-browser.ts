import { registerSecret } from '../../diagnostics/utils/redact';
import {
  HOST_BROWSER_OPEN_TOOL,
  HOST_BROWSER_SET_COOKIES_TOOL,
  HOST_BROWSER_TOOLS,
} from '../chat.types';
import { isHostToolCall } from './host-tool';

/**
 * Whether a permission request names one of geniro's OWN browser tools.
 *
 * Auto-approved in every mode: calling a browser tool is not itself the
 * decision. What the user is asked is the first open of each new host, on a
 * card of the tool's own (`BrowserBroker`), and the browser lives in this app's
 * own window under a cookie jar of its own.
 *
 * How the pair is matched belongs to {@link isHostToolCall}.
 */
export function isHostBrowserCall(
  serverName: string | null,
  toolName: string,
): boolean {
  return HOST_BROWSER_TOOLS.some((tool) =>
    isHostToolCall(serverName, toolName, tool),
  );
}

/** What a cookie value becomes in the row a browser tool call is persisted as. */
export const BROWSER_COOKIE_MASK = '‹cookie›';

const COOKIE_SECRET_LABEL = 'browser cookie';

const COOKIE_CARRIERS = [
  HOST_BROWSER_SET_COOKIES_TOOL,
  HOST_BROWSER_OPEN_TOOL,
] as const;

/**
 * Whether a tool call's name is one of the two browser tools that carry cookie
 * values in their arguments (`browser_set_cookies`, and `browser_open` with
 * `ownCookies`), in any CLI's spelling.
 *
 * Looser than {@link isHostBrowserCall} on purpose, because this guards a
 * secret rather than granting a permission: `mapEventToItem` sees an event's
 * name and not the run's server name, and masking a value in a same-named tool
 * of somebody else's server costs nothing.
 */
export function carriesBrowserCookies(toolName: string): boolean {
  return COOKIE_CARRIERS.some((tool) => namesTool(toolName, tool));
}

/** Whether a tool call's name is any of the browser tools, in any CLI's spelling. */
export function namesBrowserTool(toolName: string): boolean {
  return HOST_BROWSER_TOOLS.some((tool) => namesTool(toolName, tool));
}

function namesTool(toolName: string, tool: string): boolean {
  return (
    toolName === tool ||
    toolName.endsWith(`__${tool}`) ||
    toolName.endsWith(`: ${tool}`)
  );
}

const COOKIE_FIELDS_KEPT: ReadonlySet<string> = new Set([
  'name',
  'url',
  'domain',
  'path',
  'secure',
  'httpOnly',
  'sameSite',
  'expirationDate',
  'expires',
]);

/**
 * A copy of a cookie-carrying call's arguments with every cookie value
 * replaced by {@link BROWSER_COOKIE_MASK}, after registering each original so
 * the debug log scrubs it too. The arguments arrive in each CLI's own wrapping
 * and, from a model, in any shape — a call the tool will refuse is persisted
 * all the same — so whatever sits under a `cookies` key is masked down to the
 * fields that name a cookie rather than carry it.
 */
export function maskBrowserCookies(input: unknown): unknown {
  if (typeof input === 'string') {
    try {
      return JSON.stringify(maskBrowserCookies(JSON.parse(input)));
    } catch {
      return input;
    }
  }
  return maskNode(input);
}

function maskNode(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(maskNode);
  }
  if (typeof node !== 'object' || node === null) {
    return node;
  }
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    copy[key] = key === 'cookies' ? maskCookies(value) : maskNode(value);
  }
  return copy;
}

function maskCookies(value: unknown): unknown {
  if (typeof value === 'string') {
    return maskValue(value);
  }
  if (Array.isArray(value)) {
    return value.map(maskCookies);
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  const copy: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    copy[key] = COOKIE_FIELDS_KEPT.has(key) ? field : maskCookies(field);
  }
  return copy;
}

const MIN_RESULT_MASK_LENGTH = 8;

const MAX_MASKED_COOKIE_VALUES = 1000;

const maskedCookieValues = new Set<string>();

function maskValue(value: string): string {
  if (value === '') {
    return value;
  }
  registerSecret(value, COOKIE_SECRET_LABEL);
  registerSecret(JSON.stringify(value).slice(1, -1), COOKIE_SECRET_LABEL);
  rememberMaskedValue(value.trim());
  return BROWSER_COOKIE_MASK;
}

function rememberMaskedValue(value: string): void {
  if (value.length < MIN_RESULT_MASK_LENGTH) {
    return;
  }
  maskedCookieValues.delete(value);
  maskedCookieValues.add(value);
  if (maskedCookieValues.size > MAX_MASKED_COOKIE_VALUES) {
    const oldest = maskedCookieValues.values().next().value;
    if (oldest !== undefined) {
      maskedCookieValues.delete(oldest);
    }
  }
}

/** Forget every cookie value masked so far — test hygiene. */
export function forgetMaskedCookieValues(): void {
  maskedCookieValues.clear();
}

/**
 * Whether a tool result is one a cookie value an agent set may come back in:
 * a browser tool's, or one whose CLI names no tool on its results (claude),
 * since a page an agent reads can print the cookie it was given.
 */
export function mayEchoBrowserCookies(toolName: string | null): boolean {
  return (
    maskedCookieValues.size > 0 &&
    (toolName === null || namesBrowserTool(toolName))
  );
}

/**
 * A tool result with every cookie value an agent set masked in its text. Image
 * blocks are passed through untouched.
 */
export function maskBrowserResult(result: unknown): unknown {
  if (typeof result === 'string') {
    return maskCookieValuesIn(result);
  }
  if (Array.isArray(result)) {
    return result.map(maskBrowserResult);
  }
  if (typeof result !== 'object' || result === null) {
    return result;
  }
  if ((result as { type?: unknown }).type === 'image') {
    return result;
  }
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(result)) {
    copy[key] = maskBrowserResult(value);
  }
  return copy;
}

function maskCookieValuesIn(text: string): string {
  let out = text;
  for (const value of maskedCookieValues) {
    if (out.includes(value)) {
      out = out.split(value).join(BROWSER_COOKIE_MASK);
    }
  }
  return out;
}
