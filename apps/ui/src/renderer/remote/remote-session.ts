import {
  type PairingRefusal,
  REMOTE_CSRF_HEADER,
  REMOTE_ROUTE_PAIR,
  REMOTE_ROUTE_SESSION,
  type RemoteSessionState,
} from '../../shared/remote';

/**
 * Is this browser allowed in?
 *
 * Two calls against the LAN gateway's own routes (`shared/remote.ts` — the
 * gateway is Electron main's second listener, not the daemon, which stays
 * loopback-only). Neither is part of the daemon's generated client: they
 * answer a question the daemon has no opinion on, and a phone asks them
 * before it has any bearer token to authenticate a daemon call with at all.
 */

const UNPAIRED_SESSION: RemoteSessionState = { paired: false, deviceId: null };

/**
 * Whether a PRELOAD put a bridge on `window`, decided once when this module is
 * evaluated and never asked again.
 *
 * Reading `window.geniro` live would be wrong, because the shim's whole job is
 * to define it: `installRemoteBridge()` runs as `main.tsx`'s first statement,
 * so by the time anything renders the property exists in a browser too and a
 * live check answers "not remote" everywhere. The pairing screen would then
 * never show — the phone would load the app and every bridge call would 401
 * with nothing on screen saying why.
 *
 * Module scope is early enough by construction: this module is part of the
 * static import graph, so it is fully evaluated before ANY top-level statement
 * of the module that imports it. A real preload has run long before that; so
 * has Storybook's stub, which installs before its first import for this same
 * ordering reason.
 */
const HAS_PRELOAD_BRIDGE =
  typeof window !== 'undefined' && window.geniro !== undefined;

/**
 * True when this bundle is running in a plain browser rather than Electron —
 * the ONE predicate the rest of the app asks, so the two runtimes are never
 * told apart by a `window.geniro === undefined` check repeated at call sites,
 * each of which would be subject to the ordering trap above.
 */
export function isRemoteRuntime(): boolean {
  return !HAS_PRELOAD_BRIDGE;
}

/**
 * Is this browser already paired?
 *
 * A non-2xx reply and a network failure both answer "not paired" rather than
 * throwing: from the caller's side an unpaired browser and an unreachable
 * gateway mean the exact same thing — show the pairing screen — and a caller
 * that had to distinguish them would just do it by catching this function's
 * own throw and mapping it back to the same screen.
 */
export async function readSession(): Promise<RemoteSessionState> {
  try {
    const response = await fetch(REMOTE_ROUTE_SESSION, {
      credentials: 'same-origin',
    });
    if (!response.ok) {
      return UNPAIRED_SESSION;
    }
    return (await response.json()) as RemoteSessionState;
  } catch {
    return UNPAIRED_SESSION;
  }
}

const PAIRING_TRANSPORT_FAILURE_MESSAGE =
  'Could not reach this Mac. Check that both devices are on the same Wi-Fi and try again.';

/**
 * Try a pairing code.
 *
 * A wrong code and a lockout are both told apart only by the SERVER's own
 * wording (`PairingRefusal.message`) — this function never writes that prose
 * itself, since only the gateway knows which refusal this is and how many
 * attempts are left. A transport failure (no reply at all, or one with no
 * readable body) is the one case with no server sentence to relay, so it
 * gets the single generic message above.
 */
export async function submitPairingCode(
  code: string,
): Promise<{ ok: true } | ({ ok: false } & PairingRefusal)> {
  try {
    const response = await fetch(REMOTE_ROUTE_PAIR, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        [REMOTE_CSRF_HEADER]: '1',
      },
      body: JSON.stringify({ code }),
    });
    if (response.ok) {
      return { ok: true };
    }
    const body = (await response
      .json()
      .catch(() => null)) as Partial<PairingRefusal> | null;
    return {
      ok: false,
      message: body?.message ?? PAIRING_TRANSPORT_FAILURE_MESSAGE,
      retryAfterMs: body?.retryAfterMs,
    };
  } catch {
    return { ok: false, message: PAIRING_TRANSPORT_FAILURE_MESSAGE };
  }
}
