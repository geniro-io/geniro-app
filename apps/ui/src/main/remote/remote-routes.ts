import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';

import type { IpcMainInvokeEvent } from 'electron';

import {
  type PairingRefusal,
  REMOTE_CSRF_HEADER,
  REMOTE_SESSION_COOKIE,
  type RemoteBridgeRequest,
  type RemoteBridgeResponse,
  type RemoteRefusal,
  type RemoteSessionState,
} from '../../shared/remote';
import type { IpcRegistry } from '../ipc-registry';
import type { DeviceRegistry } from './device-registry';
import type { Pairing } from './pairing';

/** How long the session cookie is kept — a device that paired once stays paired. */
const SESSION_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/** Refuses a body past this size before it is ever parsed as JSON. */
const MAX_BODY_BYTES = 1_000_000;

/** How often an open events stream writes a keep-alive comment frame. */
const SSE_KEEPALIVE_MS = 15_000;

/** How the gateway's own request is described to a route handler. */
export interface RouteRequest {
  headers: IncomingHttpHeaders;
  cookies: Record<string, string>;
  remoteAddress: string;
  userAgent: string | undefined;
  body: unknown;
}

/** A route's whole answer — the gateway turns this into a real HTTP response. */
export interface RouteResult {
  status: number;
  body: unknown;
  /** A `Set-Cookie` value, when the route wants to plant one. */
  setCookie?: string;
}

/** What an SSE handler needs from a real `ServerResponse` — nothing else. */
export interface SseResponse {
  writeHead(status: number, headers: Record<string, string>): void;
  write(chunk: string): void;
  end(chunk?: string): void;
  on(event: 'close', listener: () => void): void;
}

export interface RemoteRoutesDeps {
  pairing: Pairing;
  deviceRegistry: DeviceRegistry;
  ipcRegistry: IpcRegistry;
}

/** Parses a `Cookie` header into a plain map. Missing/malformed pairs are dropped. */
export function parseCookies(
  header: string | undefined,
): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) {
    return cookies;
  }
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) {
      continue;
    }
    const key = part.slice(0, eq).trim();
    if (key.length === 0) {
      continue;
    }
    const rawValue = part.slice(eq + 1).trim();
    try {
      cookies[key] = decodeURIComponent(rawValue);
    } catch {
      cookies[key] = rawValue;
    }
  }
  return cookies;
}

/** Reads and JSON-parses a request body, bounded so an unbounded POST cannot grow memory without limit. */
export function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function readPairCode(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const { code } = body as Record<string, unknown>;
  return typeof code === 'string' ? code : null;
}

function readBridgeRequest(body: unknown): RemoteBridgeRequest | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const { channel, args } = body as Record<string, unknown>;
  if (typeof channel !== 'string' || channel.length === 0) {
    return null;
  }
  if (!Array.isArray(args)) {
    return null;
  }
  return { channel, args: args as unknown[] };
}

function deriveDeviceLabel(userAgent: string | undefined): string {
  const trimmed = userAgent?.trim();
  return trimmed && trimmed.length > 0
    ? trimmed.slice(0, 120)
    : 'Unknown device';
}

function buildSessionCookie(token: string): string {
  // Deliberately NOT `Secure`. This gateway serves plain HTTP on a LAN —
  // there is nowhere trustworthy for a TLS certificate naming a private,
  // DHCP-assigned host to come from — and `Secure` on an insecure origin
  // means the browser refuses to STORE the cookie at all, which would make
  // pairing a no-op rather than merely weaker.
  return `${REMOTE_SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_COOKIE_MAX_AGE_SECONDS}`;
}

/**
 * A minimal stand-in for the `IpcMainInvokeEvent` a real `ipcMain.handle`
 * callback receives. A bridge call has no WebContents behind it — the
 * request came from an HTTP body, not a renderer frame — so there is
 * nothing honest this could carry.
 *
 * It is safe to hand to an arbitrary registered handler only because of
 * WHICH handlers ever reach it: only a channel whose `RemotePolicy` is
 * `{remote: 'allow'}` is dispatched over the bridge at all (see
 * `ipc-registry.ts`), and that policy is reserved for handlers that never
 * read anything off their event — no `event.sender`, no `event.senderFrame`.
 * So rather than quietly answering `undefined` for a property a handler
 * should never touch, every property access on this object throws: a
 * handler that WAS reclassified as remote-safe while still reading its
 * event fails loudly, at the point it tries, instead of running against a
 * fabricated `sender`.
 */
function createInertIpcEvent(): IpcMainInvokeEvent {
  const handler: ProxyHandler<object> = {
    get(_target, prop) {
      throw new Error(
        `remote bridge: channel handler read '${String(prop)}' off its IpcMainInvokeEvent — only handlers with an 'allow' remote policy run over the bridge, and that policy exists because they are not supposed to touch the event at all`,
      );
    },
  };
  return new Proxy({}, handler) as unknown as IpcMainInvokeEvent;
}

/**
 * The gateway's own routes (`/__geniro/…`), built over the collaborators
 * `shared/remote.ts` already defines — injected so each handler is testable
 * against a fake `Pairing`/`DeviceRegistry`/`IpcRegistry` with no real
 * socket involved.
 */
export function createRemoteRoutes(deps: RemoteRoutesDeps) {
  function deviceForCookie(cookies: Record<string, string>) {
    const token = cookies[REMOTE_SESSION_COOKIE];
    if (!token) {
      return null;
    }
    return deps.deviceRegistry.findByToken(token);
  }

  return {
    /** `GET /__geniro/session` — whether this cookie names a paired device. */
    session(req: RouteRequest): RouteResult {
      const device = deviceForCookie(req.cookies);
      if (!device) {
        const state: RemoteSessionState = { paired: false, deviceId: null };
        return { status: 200, body: state };
      }
      deps.deviceRegistry.touch(device.id);
      const state: RemoteSessionState = { paired: true, deviceId: device.id };
      return { status: 200, body: state };
    },

    /** `POST /__geniro/pair` — verify a code and, on success, mint a session. */
    pair(req: RouteRequest): RouteResult {
      const code = readPairCode(req.body);
      if (code === null) {
        return { status: 400, body: { error: 'a 6-digit code is required' } };
      }
      const result = deps.pairing.verify(code, req.remoteAddress);
      if (result.outcome === 'accepted') {
        const token = deps.pairing.mintSessionToken();
        const device = deps.deviceRegistry.add({
          token,
          label: deriveDeviceLabel(req.userAgent),
        });
        const state: RemoteSessionState = { paired: true, deviceId: device.id };
        return {
          status: 200,
          body: state,
          setCookie: buildSessionCookie(token),
        };
      }
      if (result.outcome === 'incorrect') {
        // Deliberately no detail about attempts left or which digits
        // matched — the caller learns only that it was wrong.
        const refusal: PairingRefusal = { message: 'Incorrect code.' };
        return { status: 401, body: refusal };
      }
      const refusal: PairingRefusal = {
        message: 'Too many attempts — try again later.',
        retryAfterMs: result.retryAfterMs,
      };
      return { status: 429, body: refusal };
    },

    /** `POST /__geniro/bridge` — invoke a channel through the IPC registry. */
    async bridge(req: RouteRequest): Promise<RouteResult> {
      const device = deviceForCookie(req.cookies);
      if (!device) {
        return { status: 401, body: { error: 'not paired' } };
      }
      if (!req.headers[REMOTE_CSRF_HEADER]) {
        // The cookie is `SameSite=Strict`, which already stops a cross-site
        // form POST from riding it. This header is the second, cheap lock:
        // a form cannot set a custom header, so a cross-origin caller has
        // to make a real CORS request — and this server answers no
        // preflight at all.
        return { status: 403, body: { error: 'missing csrf header' } };
      }
      const parsed = readBridgeRequest(req.body);
      if (!parsed) {
        return { status: 400, body: { error: 'malformed bridge request' } };
      }
      const entry = deps.ipcRegistry.get(parsed.channel);
      if (!entry) {
        return {
          status: 404,
          body: { error: `no such channel: ${parsed.channel}` },
        };
      }
      if (entry.policy.remote === 'deny') {
        const refusal: RemoteRefusal = {
          code: 'REMOTE_CHANNEL_DENIED',
          channel: parsed.channel,
          reason: entry.policy.reason,
        };
        const response: RemoteBridgeResponse = { refusal };
        return { status: 200, body: response };
      }
      // A channel can be safe to call remotely in general while one FIELD of
      // its payload is not (`updateSettings`'s `cliPaths`/`daemonInspect`) —
      // refused here, before the handler runs, rather than silently dropped:
      // a caller that named a refused field gets a refusal naming it back.
      const argsRefusal = entry.policy.refuseRemoteArgs?.(parsed.args) ?? null;
      if (argsRefusal !== null) {
        const refusal: RemoteRefusal = {
          code: 'REMOTE_CHANNEL_DENIED',
          channel: parsed.channel,
          reason: argsRefusal,
        };
        const response: RemoteBridgeResponse = { refusal };
        return { status: 200, body: response };
      }
      deps.deviceRegistry.touch(device.id);
      try {
        const value = await entry.handler(
          createInertIpcEvent(),
          ...parsed.args,
        );
        // Applied HERE rather than by the handler, because the handler is the
        // same one the desktop calls and the desktop is entitled to the whole
        // answer. What a remote client may not be told is a property of the
        // CHANNEL, declared with its policy in `ipc.ts`.
        const response: RemoteBridgeResponse = {
          value:
            entry.policy.remote === 'allow' && entry.policy.redactForRemote
              ? entry.policy.redactForRemote(value)
              : value,
        };
        return { status: 200, body: response };
      } catch (error) {
        const response: RemoteBridgeResponse = {
          error: error instanceof Error ? error.message : String(error),
        };
        return { status: 200, body: response };
      }
    },

    /** `GET /__geniro/events` — a paired-only SSE stream. */
    events(req: RouteRequest, res: SseResponse): void {
      const device = deviceForCookie(req.cookies);
      if (!device) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not paired' }));
        return;
      }
      deps.deviceRegistry.touch(device.id);
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      // A `:`-prefixed line is a valid SSE comment frame carrying no event,
      // so an otherwise-idle stream still emits bytes on this interval —
      // without it, a hop that drops connections that have gone quiet (a
      // phone's own NAT among them) closes this one out from under a reader
      // who is still there. This slice carries no real events yet.
      const keepAlive = setInterval(() => {
        res.write(': keep-alive\n\n');
      }, SSE_KEEPALIVE_MS);
      res.on('close', () => {
        clearInterval(keepAlive);
      });
    },
  };
}

export type RemoteRoutes = ReturnType<typeof createRemoteRoutes>;
