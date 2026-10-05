import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  applyNetworkLockdownSwitches,
  ARTIFACT_CDN_HOSTS,
  blackHoleProxy,
  installWebContentsLockdown,
} from './network-lockdown';

/**
 * What these pin is the CONFIGURATION — which policy, which rules, which proxy
 * — because that is the part a refactor can quietly weaken. Whether Chromium
 * honours it cannot be observed from a unit test; that was measured under the
 * app's own Electron with a real sandboxed artifact frame, and the table in
 * `network-lockdown.ts` records what each piece was measured to stop.
 */
describe('network lockdown', () => {
  it('gives EVERY WebContents the app creates the no-UDP WebRTC policy, at creation', () => {
    const app = new EventEmitter();
    installWebContentsLockdown(app as never);
    const window = { setWebRTCIPHandlingPolicy: vi.fn() };
    const another = { setWebRTCIPHandlingPolicy: vi.fn() };

    app.emit('web-contents-created', {}, window);
    app.emit('web-contents-created', {}, another);

    // Not `default_public_interface_only`, which was measured to stop nothing.
    expect(window.setWebRTCIPHandlingPolicy).toHaveBeenCalledWith(
      'disable_non_proxied_udp',
    );
    expect(another.setWebRTCIPHandlingPolicy).toHaveBeenCalledWith(
      'disable_non_proxied_udp',
    );
  });

  it('refuses every hostname lookup EXCEPT the loopback the app itself talks to', () => {
    const commandLine = { appendSwitch: vi.fn() };

    applyNetworkLockdownSwitches(commandLine);

    expect(commandLine.appendSwitch).toHaveBeenCalledTimes(1);
    const [name, rules] = commandLine.appendSwitch.mock.calls[0] as [
      string,
      string,
    ];
    expect(name).toBe('host-resolver-rules');
    const parts = rules.split(',').map((part) => part.trim());
    expect(parts[0]).toBe('MAP * ~NOTFOUND');
    // Without these the daemon (127.0.0.1) and the dev server (localhost)
    // would be refused along with everything else.
    expect(parts).toContain('EXCLUDE 127.0.0.1');
    expect(parts).toContain('EXCLUDE localhost');
    // The library CDNs an artifact page loads from — by EXACT name, so no
    // name a page spells for itself resolves.
    for (const host of ARTIFACT_CDN_HOSTS) {
      expect(parts).toContain(`EXCLUDE ${host}`);
    }
    expect(parts.filter((part) => part.includes('*'))).toEqual([
      'MAP * ~NOTFOUND',
    ]);
  });

  it('sends the session’s proxied traffic to a proxy nothing answers, leaving loopback and the CDNs direct', async () => {
    const session = { setProxy: vi.fn(async () => undefined) };

    await blackHoleProxy(session);

    expect(session.setProxy).toHaveBeenCalledTimes(1);
    const [config] = session.setProxy.mock.calls[0] as unknown as [
      { proxyRules: string; proxyBypassRules?: string },
    ];
    expect(config.proxyRules).toBe('socks5://127.0.0.1:9');
    // `<-loopback>` would push the daemon's own traffic into the black hole.
    expect(config.proxyBypassRules ?? '').not.toContain('<-loopback>');
    expect((config.proxyBypassRules ?? '').split(',')).toEqual([
      ...ARTIFACT_CDN_HOSTS,
    ]);
  });

  it('exempts exactly the hosts the artifact page’s own CSP admits', () => {
    // A TWIN of the daemon's policy: a host the CSP admits but this blocks is
    // a library that fails silently in the app, and a host this admits that
    // the CSP does not is network reach nothing asked for.
    const source = readFileSync(
      join(__dirname, '../../../daemon/src/v1/agents/utils/artifact-page.ts'),
      'utf8',
    );
    const array =
      /export const ARTIFACT_PAGE_CSP = \[([\s\S]*?)\]\.join\('; '\);/.exec(
        source,
      );
    expect(array).not.toBeNull();
    const hosts = new Set(
      [...array![1]!.matchAll(/https:\/\/([a-z0-9.-]+)/g)].map(
        (match) => match[1],
      ),
    );

    expect([...hosts].sort()).toEqual([...ARTIFACT_CDN_HOSTS].sort());
  });
});
