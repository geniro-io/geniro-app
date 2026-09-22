/**
 * The LAN gateway's WIRE contract — route paths, security headers, and the
 * request/response shapes BOTH processes read: Electron main (which owns the
 * gateway itself, in `main/remote/`) and the renderer (which calls it from a
 * browser tab — real Electron or a paired phone). Everything here is safe
 * for the renderer bundle to carry.
 *
 * `main/remote/remote.types.ts` holds the other half — the main-only
 * operational tuning (rate limits, TTLs, the preferred port) the renderer
 * never needs and this file must stay free of, since a `node:` import here
 * would break the renderer build with no rule to catch it.
 */

/** How many digits a pairing code carries. */
export const PAIRING_CODE_LENGTH = 6;

/** The cookie a paired device presents on every later request. */
export const REMOTE_SESSION_COOKIE = 'geniro_remote';

/**
 * The header a bridge call must carry. See `remote-routes.ts`'s `bridge()`
 * for why (the CSRF rationale lives there, beside the check).
 */
export const REMOTE_CSRF_HEADER = 'x-geniro-remote';

/**
 * Routes the gateway answers itself rather than proxying or serving.
 *
 * Prefixed so it can never collide with a daemon route (`/v1/…`, `/ws`) or a
 * file in the renderer bundle, which is what makes "proxy everything I do not
 * recognise" a safe default instead of a guess.
 */
export const REMOTE_ROUTE_PREFIX = '/__geniro';
export const REMOTE_ROUTE_SESSION = `${REMOTE_ROUTE_PREFIX}/session`;
export const REMOTE_ROUTE_PAIR = `${REMOTE_ROUTE_PREFIX}/pair`;
export const REMOTE_ROUTE_BRIDGE = `${REMOTE_ROUTE_PREFIX}/bridge`;
export const REMOTE_ROUTE_EVENTS = `${REMOTE_ROUTE_PREFIX}/events`;

/** One device that has paired, as the registry stores it. */
export interface RemoteDevice {
  /** Opaque id, minted with the device's session token. */
  id: string;
  /**
   * The session token's hash, never the token. The file sits in userData
   * beside `daemon.json`, and a readable token is a standing key to the whole
   * daemon; a hash cannot be replayed.
   */
  tokenHash: string;
  /** What the device called itself — its user agent, trimmed. */
  label: string;
  pairedAt: string;
  lastSeenAt: string;
}

/**
 * The tunnel clients geniro knows how to drive, in the order it prefers them.
 *
 * `cloudflared` leads because its quick tunnel needs NO ACCOUNT and no
 * configuration at all — measured on a clean machine, it answered with a
 * public URL in about five seconds with an empty `~/.cloudflared`. `ngrok`
 * needs an authtoken its owner has signed up for, which the user running
 * geniro may simply not have.
 */
export type TunnelProviderId = 'cloudflared' | 'ngrok';

/**
 * The INTERNET address, when the user has asked for one.
 *
 * Distinct from the LAN fields beside it in {@link RemoteAccessState} because
 * it is a different promise: those describe a listener that is already up for
 * anyone on the Wi-Fi, this describes a child process geniro started that
 * forwards a public name to it. `off` is the resting state and the one a
 * launch starts in — a tunnel is never opened on geniro's own initiative.
 */
export interface RemoteTunnelState {
  status: 'off' | 'starting' | 'open' | 'error';
  /** Which client is running, once one has been picked. */
  provider: TunnelProviderId | null;
  /** The public URL, only in `open`. */
  url: string | null;
  /** Why it is not open, only in `error`. */
  error: string | null;
}

/**
 * The resting tunnel state, and the one every launch starts in.
 *
 * Exported because four places need to say "no public address" — the
 * supervisor, the Storybook double and two specs — and four literals is four
 * chances for one of them to describe a state the supervisor cannot produce.
 */
export const TUNNEL_OFF: RemoteTunnelState = {
  status: 'off',
  provider: null,
  url: null,
  error: null,
};

/** What Settings draws, and what the "open in browser" action builds a link from. */
export interface RemoteAccessState {
  /** The user's switch (`Settings.remoteAccessEnabled`). */
  enabled: boolean;
  /** Whether the listener is actually up — a bind can fail with the switch on. */
  listening: boolean;
  /** The bound port, or null when nothing is listening. */
  port: number | null;
  /**
   * `http://<hostname>.local:<port>` — the primary link. macOS publishes the
   * machine's own `.local` name over Bonjour with no help from this app, so
   * there is no responder to run and nothing to register.
   */
  hostUrl: string | null;
  /**
   * `http://<lan-ipv4>:<port>` — the fallback, for a network where `.local`
   * does not resolve (some Android builds, some guest networks). Both are
   * shown, because neither works everywhere.
   */
  addressUrl: string | null;
  /** The code a new device must type, and when it rotates. */
  pairingCode: string | null;
  pairingCodeExpiresAt: string | null;
  /** Devices that have paired, newest first. */
  devices: RemoteDevice[];
  /** Why nothing is listening, when that is the case. */
  unavailableReason: string | null;
  /** The public address, when one has been asked for. See {@link RemoteTunnelState}. */
  tunnel: RemoteTunnelState;
}

/**
 * What the LISTENER alone can answer.
 *
 * The gateway knows about its own socket, its links, its pairing code and its
 * devices; it does not know the user's switch and it does not own the tunnel
 * child process. `RemoteAccess` composes those two in, so this type is what
 * keeps the gateway from being able to invent either.
 */
export type RemoteGatewayState = Omit<RemoteAccessState, 'tunnel'>;

/** What a paired browser is told about itself. */
export interface RemoteSessionState {
  paired: boolean;
  deviceId: string | null;
}

/**
 * A pairing attempt that did NOT succeed — the one shape `remote-routes.ts`
 * writes and `remote-session.ts` reads, imported by both so a route's wording
 * and the screen's parse of it cannot drift into two different fields again.
 * `retryAfterMs` is set only for a lockout refusal.
 */
export interface PairingRefusal {
  message: string;
  retryAfterMs?: number;
}

/**
 * A bridge call refused because the channel is native-only.
 *
 * It is a SHAPE rather than a message so the renderer can tell it from a
 * transport failure: a refusal is permanent and the UI disables the control,
 * while a failure is worth retrying. `code` is what the shim matches on.
 */
export interface RemoteRefusal {
  code: 'REMOTE_CHANNEL_DENIED';
  channel: string;
  reason: string;
}

/** One bridge call, as the browser sends it. */
export interface RemoteBridgeRequest {
  channel: string;
  args: unknown[];
}

/** One bridge reply. Exactly one of `value` / `error` / `refusal` is set. */
export interface RemoteBridgeResponse {
  value?: unknown;
  error?: string;
  refusal?: RemoteRefusal;
}
