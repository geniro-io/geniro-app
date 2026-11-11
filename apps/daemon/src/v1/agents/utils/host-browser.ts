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
  return COOKIE_CARRIERS.some(
    (tool) =>
      toolName === tool ||
      toolName.endsWith(`__${tool}`) ||
      toolName.endsWith(`: ${tool}`),
  );
}

/**
 * A copy of a cookie-carrying call's arguments with every cookie `value`
 * replaced by {@link BROWSER_COOKIE_MASK}, after registering each original so
 * the debug log scrubs it too. The arguments arrive in each CLI's own wrapping,
 * so every `cookies` array is masked wherever it sits.
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
    copy[key] =
      key === 'cookies' && Array.isArray(value)
        ? value.map(maskCookie)
        : maskNode(value);
  }
  return copy;
}

function maskCookie(cookie: unknown): unknown {
  if (typeof cookie !== 'object' || cookie === null || Array.isArray(cookie)) {
    return maskNode(cookie);
  }
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(cookie)) {
    if (key === 'value' && typeof value === 'string') {
      registerSecret(value, COOKIE_SECRET_LABEL);
      registerSecret(JSON.stringify(value).slice(1, -1), COOKIE_SECRET_LABEL);
      copy[key] = BROWSER_COOKIE_MASK;
    } else {
      copy[key] = maskNode(value);
    }
  }
  return copy;
}
