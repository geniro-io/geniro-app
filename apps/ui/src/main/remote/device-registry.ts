import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

import type { RemoteDevice } from '../../shared/remote';

/**
 * Options-as-test-seams: the caller (main, over `app.getPath('userData')`)
 * decides the path, so a spec needs no Electron. `now` is likewise
 * injectable — every timestamp this module writes goes through it.
 */
export interface DeviceRegistryOptions {
  filePath: string;
  now?: () => string;
}

export interface AddDeviceInput {
  /** The raw session token, as `Pairing.mintSessionToken()` produced it. Never stored. */
  token: string;
  label: string;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isIsoTimestamp(value: unknown): value is string {
  return isNonEmptyString(value) && !Number.isNaN(Date.parse(value));
}

/**
 * One entry salvaged from the on-disk record, or null. Mirrors
 * `settings.ts`'s `salvageList`: a field that fails its shape check costs
 * only this entry, never the whole file.
 */
function parseDevice(candidate: unknown): RemoteDevice | null {
  if (typeof candidate !== 'object' || candidate === null) {
    return null;
  }
  const record = candidate as Record<string, unknown>;
  const { id, tokenHash, label, pairedAt, lastSeenAt } = record;
  if (!isNonEmptyString(id)) {
    return null;
  }
  if (!isNonEmptyString(tokenHash) || !SHA256_HEX.test(tokenHash)) {
    return null;
  }
  if (typeof label !== 'string') {
    return null;
  }
  if (!isIsoTimestamp(pairedAt) || !isIsoTimestamp(lastSeenAt)) {
    return null;
  }
  return { id, tokenHash, label, pairedAt, lastSeenAt };
}

/**
 * An unreadable or malformed file reads as EMPTY — the safe direction, since
 * the only thing this file authorises is admitting a device onto the LAN
 * gateway. Ids are de-duplicated (first occurrence wins), the same guard
 * `salvageList` applies to the other hand-written settings lists.
 */
function readDevicesFile(filePath: string): RemoteDevice[] {
  if (!existsSync(filePath)) {
    return [];
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) {
    return [];
  }
  const salvaged: RemoteDevice[] = [];
  const seen = new Set<string>();
  for (const candidate of raw) {
    const device = parseDevice(candidate);
    if (!device || seen.has(device.id)) {
      continue;
    }
    seen.add(device.id);
    salvaged.push(device);
  }
  return salvaged;
}

/**
 * Atomic write at 0600. The mode is set at CREATION of the temp file, never
 * via a later chmod — a write-then-chmod leaves a window where the file
 * (holding token hashes) is world-readable.
 */
function writeDevicesFile(filePath: string, devices: RemoteDevice[]): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(devices, null, 2), { mode: 0o600 });
  renameSync(tmp, filePath);
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** The paired devices, persisted at `<userData>/remote-devices.json`. */
export class DeviceRegistry {
  private readonly filePath: string;
  private readonly now: () => string;

  constructor(options: DeviceRegistryOptions) {
    this.filePath = options.filePath;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  add(input: AddDeviceInput): RemoteDevice {
    const devices = readDevicesFile(this.filePath);
    const timestamp = this.now();
    const device: RemoteDevice = {
      id: randomUUID(),
      tokenHash: hashToken(input.token),
      label: input.label.trim(),
      pairedAt: timestamp,
      lastSeenAt: timestamp,
    };
    devices.unshift(device);
    writeDevicesFile(this.filePath, devices);
    return device;
  }

  /** Newest first, by `pairedAt`. */
  list(): RemoteDevice[] {
    return readDevicesFile(this.filePath).sort(
      (a, b) => Date.parse(b.pairedAt) - Date.parse(a.pairedAt),
    );
  }

  touch(id: string): void {
    const devices = readDevicesFile(this.filePath);
    const index = devices.findIndex((device) => device.id === id);
    const current = index === -1 ? undefined : devices[index];
    if (index === -1 || !current) {
      return;
    }
    devices[index] = { ...current, lastSeenAt: this.now() };
    writeDevicesFile(this.filePath, devices);
  }

  /** Returns whether a device was actually removed. */
  revoke(id: string): boolean {
    const devices = readDevicesFile(this.filePath);
    const next = devices.filter((device) => device.id !== id);
    if (next.length === devices.length) {
      return false;
    }
    writeDevicesFile(this.filePath, next);
    return true;
  }

  /** Hashes the presented token and compares against the stored hashes. */
  findByToken(token: string): RemoteDevice | null {
    const hash = hashToken(token);
    const devices = readDevicesFile(this.filePath);
    return devices.find((device) => device.tokenHash === hash) ?? null;
  }
}
