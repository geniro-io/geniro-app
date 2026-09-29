import type { App, Session, WebContents } from 'electron';

/**
 * What keeps a page this app FRAMES — an agent-authored artifact — off the
 * network, where the page's own CSP cannot reach.
 *
 * The artifact frame is `sandbox="allow-scripts"` under `default-src 'none'`,
 * which stops fetch, XHR, WebSocket, subresources and navigation. It does not
 * stop WebRTC: CSP has no directive for `RTCPeerConnection`, and an ICE server
 * or a remote candidate is a network destination the page names itself.
 * MEASURED under this app's Electron with the exact artifact CSP, the frame
 * sandboxed inside a page under the renderer's own CSP, every destination an
 * address on this machine's LAN interface (so "reached" is observable):
 *
 * | measure                              | STUN/UDP | TURN/UDP | TURN/TCP | ICE UDP | ICE TCP | DNS for a TURN hostname |
 * | ------------------------------------ | -------- | -------- | -------- | ------- | ------- | ----------------------- |
 * | none                                 | 5 pkts   | 10 pkts  | 1 conn   | 97 pkts | 1 conn  | queried                 |
 * | policy only                          | 0        | 0        | 1 conn   | 0       | 2 conns | queried                 |
 * | policy + black-hole proxy            | 0        | 0        | 0        | 0       | 0       | STILL queried           |
 * | policy + resolver rules              | 0        | 0        | 0        | 0       | 0       | none                    |
 * | `force-webrtc-ip-handling-policy`    | 5 pkts   | 10 pkts  | 1 conn   | 97 pkts | 1 conn  | —                       |
 *
 * So the policy alone stops only UDP; TCP (a TURN server, or a remote ICE-TCP
 * candidate the page adds itself) still leaves. The proxy closes TCP, and the
 * DNS query WebRTC makes to resolve a TURN hostname — a channel that carries
 * whatever the page spells into the name — survives it, which is what the
 * resolver rules close. The Chromium switch that sounds like the policy did
 * nothing at all here. All three measures below are applied; each closes a
 * channel the others were measured not to.
 *
 * None of it costs the app anything, and that is what makes it safe to apply
 * process-wide: the renderer's own CSP already confines it to `'self'` and
 * `127.0.0.1`, loopback is never proxied, and every outbound request this app
 * makes on purpose — the update feed, `gh`, a tunnel — is made by Node or by a
 * child process, neither of which uses Chromium's network stack.
 */

/**
 * WebRTC may use no UDP that is not proxied — and there is no proxy that
 * carries UDP, so in effect no UDP at all.
 */
export const WEBRTC_IP_HANDLING_POLICY = 'disable_non_proxied_udp';

/**
 * Every hostname Chromium resolves answers NOT FOUND, except loopback — the
 * daemon (`127.0.0.1`) and the dev server (`localhost`). Measured to also
 * refuse a TCP connect to a non-loopback IP LITERAL, since `*` matches one.
 */
export const HOST_RESOLVER_RULES =
  'MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1';

/**
 * A proxy nothing answers on, for every destination but loopback (which
 * Chromium never proxies). Under the policy WebRTC sends its TCP through the
 * session's proxy, so this is where that TCP goes to die. A SOCKS handshake
 * sent to the discard port is refused or answered with nonsense either way.
 */
export const BLACK_HOLE_PROXY = 'socks5://127.0.0.1:9';

/**
 * The part that must be in place before the app is ready — Chromium reads its
 * switches when its network service starts.
 */
export function applyNetworkLockdownSwitches(
  commandLine: Pick<App['commandLine'], 'appendSwitch'>,
): void {
  commandLine.appendSwitch('host-resolver-rules', HOST_RESOLVER_RULES);
}

/** The per-page part: WebRTC's policy is a property of each WebContents. */
export function lockDownWebContents(
  contents: Pick<WebContents, 'setWebRTCIPHandlingPolicy'>,
): void {
  contents.setWebRTCIPHandlingPolicy(WEBRTC_IP_HANDLING_POLICY);
}

/**
 * Apply {@link lockDownWebContents} to EVERY WebContents this app creates —
 * the main window, a reopened one, DevTools, anything added later — at the
 * moment it is created, before it can load a page. Keyed on creation rather
 * than on `createWindow` so a second window path cannot forget it.
 */
export function installWebContentsLockdown(app: Pick<App, 'on'>): void {
  app.on('web-contents-created', (_event, contents) => {
    lockDownWebContents(contents);
  });
}

/** The session part: see {@link BLACK_HOLE_PROXY}. */
export async function blackHoleProxy(
  session: Pick<Session, 'setProxy'>,
): Promise<void> {
  await session.setProxy({ proxyRules: BLACK_HOLE_PROXY });
}
