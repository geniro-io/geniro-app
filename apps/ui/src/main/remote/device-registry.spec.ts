import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import type { RemoteDevice } from '../../shared/remote';
import { DeviceRegistry } from './device-registry';

let dir: string;
let filePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'geniro-device-registry-'));
  filePath = join(dir, 'remote-devices.json');
});

function registryAt(now?: () => string): DeviceRegistry {
  return new DeviceRegistry({ filePath, now });
}

describe('DeviceRegistry', () => {
  it('adds a device and hashes the token rather than storing it', () => {
    const registry = registryAt();
    const device = registry.add({ token: 'raw-token', label: 'iPhone' });

    expect(device.tokenHash).toBe(
      createHash('sha256').update('raw-token').digest('hex'),
    );
    const onDisk = readFileSync(filePath, 'utf8');
    expect(onDisk).not.toContain('raw-token');
  });

  it('writes the file atomically at mode 0600', () => {
    const registry = registryAt();
    registry.add({ token: 'raw-token', label: 'iPhone' });

    const mode = statSync(filePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('trims the label', () => {
    const registry = registryAt();
    const device = registry.add({ token: 't', label: '  iPhone 15  ' });
    expect(device.label).toBe('iPhone 15');
  });

  it('lists devices newest first', () => {
    let clockValue = 0;
    const now = () => {
      clockValue += 1;
      return new Date(clockValue * 1000).toISOString();
    };
    const registry = registryAt(now);
    const first = registry.add({ token: 't1', label: 'first' });
    const second = registry.add({ token: 't2', label: 'second' });

    expect(registry.list().map((d) => d.id)).toEqual([second.id, first.id]);
  });

  it('touch updates lastSeenAt for the matching device and nothing else', () => {
    const pairedAt = '2024-01-01T00:00:00.000Z';
    const touchedAt = '2024-01-02T00:00:00.000Z';
    let call = 0;
    const registry = registryAt(() => (call++ === 0 ? pairedAt : touchedAt));
    const device = registry.add({ token: 't', label: 'iPhone' });
    expect(device.pairedAt).toBe(pairedAt);

    registry.touch(device.id);

    const [reread] = registry.list();
    expect(reread).toBeDefined();
    expect(reread?.pairedAt).toBe(pairedAt);
    expect(reread?.lastSeenAt).toBe(touchedAt);
  });

  it('touch is a no-op for an unknown id', () => {
    const registry = registryAt();
    registry.add({ token: 't', label: 'iPhone' });
    expect(() => registry.touch('does-not-exist')).not.toThrow();
    expect(registry.list()).toHaveLength(1);
  });

  it('revokes a device and reports whether one was removed', () => {
    const registry = registryAt();
    const device = registry.add({ token: 't', label: 'iPhone' });

    expect(registry.revoke('does-not-exist')).toBe(false);
    expect(registry.revoke(device.id)).toBe(true);
    expect(registry.list()).toHaveLength(0);
  });

  it('findByToken hashes the presented token and matches by hash', () => {
    const registry = registryAt();
    const device = registry.add({ token: 'the-real-token', label: 'iPhone' });

    expect(registry.findByToken('the-real-token')?.id).toBe(device.id);
    expect(registry.findByToken('wrong-token')).toBeNull();
  });

  it('reads an unreadable file as empty rather than throwing', () => {
    writeFileSync(filePath, '{ not valid json', 'utf8');
    const registry = registryAt();
    expect(registry.list()).toEqual([]);
  });

  it('reads a file holding something other than an array as empty', () => {
    writeFileSync(filePath, JSON.stringify({ devices: [] }), 'utf8');
    const registry = registryAt();
    expect(registry.list()).toEqual([]);
  });

  it('salvages entry by entry: one malformed device costs only itself', () => {
    const good: RemoteDevice = {
      id: 'good-id',
      tokenHash: 'a'.repeat(64),
      label: 'Good phone',
      pairedAt: '2024-01-01T00:00:00.000Z',
      lastSeenAt: '2024-01-01T00:00:00.000Z',
    };
    const onDisk = [
      good,
      { id: 'missing-hash', label: 'no hash', pairedAt: 'x', lastSeenAt: 'x' },
      { ...good, id: 'bad-hash', tokenHash: 'not-hex' },
      { ...good, id: 'bad-date', pairedAt: 'not-a-date' },
      'a bare string, not even an object',
      null,
    ];
    writeFileSync(filePath, JSON.stringify(onDisk), 'utf8');

    const registry = registryAt();
    expect(registry.list().map((d) => d.id)).toEqual(['good-id']);
  });

  it('de-duplicates ids on read, keeping the first occurrence', () => {
    const first: RemoteDevice = {
      id: 'dup',
      tokenHash: 'a'.repeat(64),
      label: 'First',
      pairedAt: '2024-01-01T00:00:00.000Z',
      lastSeenAt: '2024-01-01T00:00:00.000Z',
    };
    const second: RemoteDevice = { ...first, label: 'Second' };
    writeFileSync(filePath, JSON.stringify([first, second]), 'utf8');

    const registry = registryAt();
    const list = registry.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.label).toBe('First');
  });
});
