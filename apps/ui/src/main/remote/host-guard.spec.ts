import { describe, expect, it } from 'vitest';

import { isAllowedHost } from './host-guard';

const options = { port: 47616, allowedHostNames: ['my-mac'] };

describe('isAllowedHost', () => {
  it('refuses an absent or empty header', () => {
    expect(isAllowedHost(undefined, options)).toBe(false);
    expect(isAllowedHost(null, options)).toBe(false);
    expect(isAllowedHost('', options)).toBe(false);
    expect(isAllowedHost('   ', options)).toBe(false);
  });

  it('accepts loopback literals', () => {
    expect(isAllowedHost('127.0.0.1:47616', options)).toBe(true);
    expect(isAllowedHost('127.0.0.1', options)).toBe(true);
    expect(isAllowedHost('localhost:47616', options)).toBe(true);
    expect(isAllowedHost('[::1]:47616', options)).toBe(true);
  });

  it('accepts private IPv4 literals across every RFC1918 + link-local range', () => {
    expect(isAllowedHost('10.1.2.3:47616', options)).toBe(true);
    expect(isAllowedHost('172.16.0.1:47616', options)).toBe(true);
    expect(isAllowedHost('172.31.255.255:47616', options)).toBe(true);
    expect(isAllowedHost('192.168.0.1:47616', options)).toBe(true);
    expect(isAllowedHost('169.254.1.1:47616', options)).toBe(true);
  });

  it('refuses an IPv4 literal just outside the 172.16/12 range', () => {
    expect(isAllowedHost('172.15.255.255:47616', options)).toBe(false);
    expect(isAllowedHost('172.32.0.0:47616', options)).toBe(false);
  });

  it('refuses a public IPv4 literal', () => {
    expect(isAllowedHost('8.8.8.8:47616', options)).toBe(false);
  });

  it('accepts IPv6 literals that can only name a machine on this link', () => {
    expect(isAllowedHost('[fe80::1]', options)).toBe(true);
    expect(isAllowedHost('[FE80::abcd]:47616', options)).toBe(true);
    expect(isAllowedHost('[febf::1]', options)).toBe(true);
    expect(isAllowedHost('[fd00::1]:47616', options)).toBe(true);
    expect(isAllowedHost('[fc00::1]', options)).toBe(true);
  });

  // The guard's second job: it is what keeps the gateway a LAN feature. A Mac
  // routinely holds a globally-routable IPv6 address via SLAAC, so accepting
  // every literal would publish it to the open internet.
  it('refuses a globally-routable IPv6 literal', () => {
    expect(isAllowedHost('[2001:db8::1]:47616', options)).toBe(false);
    expect(isAllowedHost('[2606:4700::1111]', options)).toBe(false);
    expect(isAllowedHost('[::]', options)).toBe(false);
  });

  it('decides an IPv4-mapped literal by the address it carries', () => {
    expect(isAllowedHost('[::ffff:192.168.1.7]:47616', options)).toBe(true);
    expect(isAllowedHost('[::ffff:8.8.8.8]:47616', options)).toBe(false);
  });

  it('accepts a name ending in .local', () => {
    expect(isAllowedHost('my-mac.local:47616', options)).toBe(true);
    expect(isAllowedHost('MY-MAC.LOCAL:47616', options)).toBe(true);
  });

  it('accepts a name in allowedHostNames', () => {
    expect(isAllowedHost('my-mac:47616', options)).toBe(true);
    expect(isAllowedHost('MY-MAC:47616', options)).toBe(true);
  });

  it('refuses a public DNS name — the whole point of the guard', () => {
    expect(isAllowedHost('evil.example.com:47616', options)).toBe(false);
    expect(isAllowedHost('attacker.io', options)).toBe(false);
  });

  it('refuses a name not on the allowlist even without a port', () => {
    expect(isAllowedHost('some-other-host', options)).toBe(false);
  });

  it('refuses when the port is present and does not match', () => {
    expect(isAllowedHost('127.0.0.1:9999', options)).toBe(false);
    expect(isAllowedHost('my-mac.local:9999', options)).toBe(false);
    expect(isAllowedHost('[::1]:9999', options)).toBe(false);
  });

  it('accepts a private IPv4 literal with no port at all', () => {
    expect(isAllowedHost('192.168.1.1', options)).toBe(true);
  });
});

// The widening a TUNNEL needs. Every assertion here fails if `wildcardAdmits`
// is deleted or loosened, which is the point: this is the one entry shape that
// admits a name outside the LAN, so its bounds are the bounds of the whole
// exception.
describe('isAllowedHost — a `*.suffix` entry', () => {
  const tunnelled = {
    port: 47616,
    allowedHostNames: ['my-mac', '*.trycloudflare.com'],
  };

  it('admits a subdomain of the suffix, on the tunnel’s own port', () => {
    // No port: what a browser actually sends for https.
    expect(
      isAllowedHost('keyword-portsmouth-product.trycloudflare.com', tunnelled),
    ).toBe(true);
    // And with the tunnel's 443 rather than this listener's port, which the
    // ordinary port check would refuse — the reason the wildcard is tested
    // before it.
    expect(isAllowedHost('abc.trycloudflare.com:443', tunnelled)).toBe(true);
  });

  it('admits the rotated address the mask exists for', () => {
    // ngrok was measured reassigning its subdomain mid-session, so a guard
    // pinned to one value would refuse a live tunnel.
    const ngrok = { port: 47616, allowedHostNames: ['*.ngrok-free.app'] };
    expect(isAllowedHost('9b36-37-99-2-231.ngrok-free.app', ngrok)).toBe(true);
    expect(isAllowedHost('5cd3-37-99-2-231.ngrok-free.app', ngrok)).toBe(true);
  });

  it('refuses a name that merely ENDS in the suffix without a label break', () => {
    expect(isAllowedHost('evil-trycloudflare.com', tunnelled)).toBe(false);
    expect(isAllowedHost('nottrycloudflare.com', tunnelled)).toBe(false);
  });

  it('refuses the bare suffix itself and another provider’s zone', () => {
    expect(isAllowedHost('trycloudflare.com', tunnelled)).toBe(false);
    expect(isAllowedHost('abc.ngrok-free.app', tunnelled)).toBe(false);
  });

  // The two shapes that would turn the guard off. Both must be refused by the
  // GUARD, not merely never offered by the tunnel supervisor.
  it('refuses a bare `*`', () => {
    const wide = { port: 47616, allowedHostNames: ['*'] };
    expect(isAllowedHost('evil.example.com', wide)).toBe(false);
    expect(isAllowedHost('anything', wide)).toBe(false);
  });

  it('refuses a one-label suffix — a whole TLD anyone can register inside', () => {
    const tld = { port: 47616, allowedHostNames: ['*.app', '*.com'] };
    expect(isAllowedHost('evil.app', tld)).toBe(false);
    expect(isAllowedHost('attacker.com', tld)).toBe(false);
  });

  it('leaves every other arm of the guard exactly as it was', () => {
    // A wildcard entry must widen and never REPLACE: the LAN rules and the
    // port check still hold for everything it does not admit.
    expect(isAllowedHost('192.168.1.7:47616', tunnelled)).toBe(true);
    expect(isAllowedHost('my-mac.local:47616', tunnelled)).toBe(true);
    expect(isAllowedHost('127.0.0.1:9999', tunnelled)).toBe(false);
    expect(isAllowedHost('8.8.8.8:47616', tunnelled)).toBe(false);
    expect(isAllowedHost('[2001:db8::1]:47616', tunnelled)).toBe(false);
  });
});
