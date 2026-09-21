import { describe, expect, it } from 'vitest';

import type { NetworkInterfaces } from './net-links';
import { buildRemoteLinks, hostLocalName, lanAddresses } from './net-links';

describe('lanAddresses', () => {
  it('returns non-internal IPv4 addresses', () => {
    const interfaces: NetworkInterfaces = {
      en0: [
        {
          address: '192.168.1.42',
          family: 'IPv4',
          internal: false,
          mac: '00:00:00:00:00:00',
          netmask: '255.255.255.0',
          cidr: '192.168.1.42/24',
        },
      ],
    };
    expect(lanAddresses(interfaces)).toEqual(['192.168.1.42']);
  });

  it('skips internal (loopback) addresses', () => {
    const interfaces: NetworkInterfaces = {
      lo0: [
        {
          address: '127.0.0.1',
          family: 'IPv4',
          internal: true,
          mac: '00:00:00:00:00:00',
          netmask: '255.0.0.0',
          cidr: '127.0.0.1/8',
        },
      ],
    };
    expect(lanAddresses(interfaces)).toEqual([]);
  });

  it('skips link-local addresses (169.254.0.0/16)', () => {
    const interfaces: NetworkInterfaces = {
      en0: [
        {
          address: '169.254.10.5',
          family: 'IPv4',
          internal: false,
          mac: '00:00:00:00:00:00',
          netmask: '255.255.0.0',
          cidr: '169.254.10.5/16',
        },
      ],
    };
    expect(lanAddresses(interfaces)).toEqual([]);
  });

  it('skips IPv6 entries', () => {
    const interfaces: NetworkInterfaces = {
      en0: [
        {
          address: 'fe80::1',
          family: 'IPv6',
          internal: false,
          mac: '00:00:00:00:00:00',
          netmask: 'ffff:ffff:ffff:ffff::',
          cidr: 'fe80::1/64',
          scopeid: 1,
        },
      ],
    };
    expect(lanAddresses(interfaces)).toEqual([]);
  });

  it('tolerates an interface entry with no addresses at all', () => {
    const interfaces: NetworkInterfaces = { en1: undefined };
    expect(lanAddresses(interfaces)).toEqual([]);
  });

  it('collects addresses across multiple interfaces', () => {
    const interfaces: NetworkInterfaces = {
      en0: [
        {
          address: '192.168.1.10',
          family: 'IPv4',
          internal: false,
          mac: '00:00:00:00:00:00',
          netmask: '255.255.255.0',
          cidr: '192.168.1.10/24',
        },
      ],
      en1: [
        {
          address: '10.0.0.5',
          family: 'IPv4',
          internal: false,
          mac: '00:00:00:00:00:00',
          netmask: '255.0.0.0',
          cidr: '10.0.0.5/8',
        },
      ],
    };
    expect(lanAddresses(interfaces)).toEqual(['192.168.1.10', '10.0.0.5']);
  });
});

describe('hostLocalName', () => {
  it('appends .local to a bare hostname', () => {
    expect(hostLocalName('MacBook-Pro')).toBe('macbook-pro.local');
  });

  it('does not double the suffix on an already-.local name', () => {
    expect(hostLocalName('MacBook-Pro.local')).toBe('macbook-pro.local');
  });

  it('returns null for an empty hostname', () => {
    expect(hostLocalName('')).toBeNull();
    expect(hostLocalName('   ')).toBeNull();
  });

  it('returns null for localhost', () => {
    expect(hostLocalName('localhost')).toBeNull();
    expect(hostLocalName('LOCALHOST')).toBeNull();
  });
});

describe('buildRemoteLinks', () => {
  it('builds both links when a hostname and a LAN address are available', () => {
    const links = buildRemoteLinks(47616, {
      hostname: 'MacBook-Pro',
      interfaces: {
        en0: [
          {
            address: '192.168.1.10',
            family: 'IPv4',
            internal: false,
            mac: '00:00:00:00:00:00',
            netmask: '255.255.255.0',
            cidr: '192.168.1.10/24',
          },
        ],
      },
    });
    expect(links).toEqual({
      hostUrl: 'http://macbook-pro.local:47616',
      addressUrl: 'http://192.168.1.10:47616',
    });
  });

  it('returns null links when nothing can be built', () => {
    const links = buildRemoteLinks(47616, {
      hostname: 'localhost',
      interfaces: {},
    });
    expect(links).toEqual({ hostUrl: null, addressUrl: null });
  });
});
