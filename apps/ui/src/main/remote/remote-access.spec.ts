import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { RemoteAccessState } from '../../shared/remote';
import { IpcRegistry } from '../ipc-registry';
import { DeviceRegistry } from './device-registry';
import { Pairing } from './pairing';
import {
  RemoteAccess,
  type RemoteAccessGateway,
  type RemoteAccessOptions,
} from './remote-access';

/**
 * A gateway double that behaves like the real `RemoteGateway` closely enough
 * to exercise `RemoteAccess` without binding a port: `start`/`stop` are
 * idempotent and flip a `listening` flag, and `state()` reads the SAME
 * `Pairing`/`DeviceRegistry` instances the test constructs — so
 * `regenerateCode`/`revokeDevice` are observable through it exactly as they
 * would be through the real gateway.
 */
function makeFakeGateway(
  pairing: Pairing,
  deviceRegistry: DeviceRegistry,
): {
  gateway: RemoteAccessGateway;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  failNextStart: (message: string) => void;
} {
  let listening = false;
  let nextStartFailure: string | null = null;

  const start = vi.fn(async () => {
    if (nextStartFailure !== null) {
      const message = nextStartFailure;
      nextStartFailure = null;
      throw new Error(message);
    }
    listening = true;
  });
  const stop = vi.fn(async () => {
    listening = false;
  });
  const state = vi.fn((): RemoteAccessState => ({
    enabled: listening,
    listening,
    port: listening ? 4823 : null,
    hostUrl: null,
    addressUrl: null,
    pairingCode: listening ? pairing.currentCode() : null,
    pairingCodeExpiresAt: null,
    devices: deviceRegistry.list(),
    unavailableReason: listening ? null : 'not listening',
  }));

  return {
    gateway: { start, stop, state },
    start,
    stop,
    failNextStart: (message: string) => {
      nextStartFailure = message;
    },
  };
}

/** One RemoteAccess wired to a fresh double gateway and a real, on-disk device registry. */
function makeHarness(remoteAccessEnabled: boolean): {
  remoteAccess: RemoteAccess;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  failNextStart: (message: string) => void;
  setEnabled: (value: boolean) => void;
} {
  const pairing = new Pairing();
  const dir = mkdtempSync(join(tmpdir(), 'geniro-remote-access-'));
  const deviceRegistry = new DeviceRegistry({
    filePath: join(dir, 'remote-devices.json'),
  });
  const { gateway, start, stop, failNextStart } = makeFakeGateway(
    pairing,
    deviceRegistry,
  );
  let enabled = remoteAccessEnabled;
  const options: RemoteAccessOptions = {
    ipcRegistry: new IpcRegistry(),
    daemonHandle: () => null,
    pairing,
    deviceRegistry,
    gateway,
    readSettings: () => ({ remoteAccessEnabled: enabled }),
  };
  return {
    remoteAccess: new RemoteAccess(options),
    start,
    stop,
    failNextStart,
    setEnabled: (value: boolean) => {
      enabled = value;
    },
  };
}

describe('RemoteAccess.sync', () => {
  it('starts the gateway when the setting is on', async () => {
    const { remoteAccess, start } = makeHarness(true);

    await remoteAccess.sync();

    expect(start).toHaveBeenCalledOnce();
    expect(remoteAccess.state().listening).toBe(true);
  });

  it('stops the gateway when the setting is off', async () => {
    const { remoteAccess, start, stop, setEnabled } = makeHarness(true);
    await remoteAccess.sync();
    expect(start).toHaveBeenCalledOnce();

    setEnabled(false);
    await remoteAccess.sync();

    expect(stop).toHaveBeenCalledOnce();
    expect(remoteAccess.state().listening).toBe(false);
  });

  it('is idempotent — calling it again with the same answer changes nothing observable', async () => {
    const { remoteAccess, start } = makeHarness(true);

    await remoteAccess.sync();
    await remoteAccess.sync();
    await remoteAccess.sync();

    // The gateway's own start/stop are what make repeats a no-op; this pins
    // that RemoteAccess keeps calling through on every sync (never latches a
    // "did I already do this" flag of its own that could fall out of step
    // with the gateway), and the observable state never wavers.
    expect(start).toHaveBeenCalledTimes(3);
    expect(remoteAccess.state().listening).toBe(true);
  });

  it('never throws on a bind failure, and surfaces it as unavailableReason instead', async () => {
    const { remoteAccess, failNextStart } = makeHarness(true);
    failNextStart('EADDRINUSE: address already in use');

    // If sync() reverted to letting the gateway's rejection propagate, this
    // await would reject and fail the test right here.
    await expect(remoteAccess.sync()).resolves.toBeUndefined();

    const state = remoteAccess.state();
    expect(state.listening).toBe(false);
    expect(state.unavailableReason).toBe('EADDRINUSE: address already in use');
  });

  it('state().enabled reflects the setting while listening reflects the server — they differ on a failed bind', async () => {
    const { remoteAccess, failNextStart } = makeHarness(true);
    failNextStart('bind refused');

    await remoteAccess.sync();
    const state = remoteAccess.state();

    // The setting is ON (the user asked for this), but nothing is actually
    // listening — the exact case the Settings panel exists to show, and the
    // one a naive `state()` that just forwarded the gateway's own `enabled`
    // (which IS its `listening`) could never express.
    expect(state.enabled).toBe(true);
    expect(state.listening).toBe(false);
  });

  it('clears a stale failure reason once a later sync actually binds', async () => {
    const { remoteAccess, failNextStart } = makeHarness(true);
    failNextStart('bind refused');
    await remoteAccess.sync();
    expect(remoteAccess.state().unavailableReason).toBe('bind refused');

    // No failure queued this time — the bind succeeds.
    await remoteAccess.sync();

    const state = remoteAccess.state();
    expect(state.listening).toBe(true);
    expect(state.unavailableReason).toBeNull();
  });
});

describe('RemoteAccess.regenerateCode', () => {
  it('changes the pairing code and returns the whole state', async () => {
    const { remoteAccess } = makeHarness(true);
    await remoteAccess.sync();
    const before = remoteAccess.state().pairingCode;

    const after = remoteAccess.regenerateCode();

    expect(after.pairingCode).not.toBe(before);
    // The reply IS the redraw source — a caller must not need a second
    // `state()` round trip to see the new code.
    expect(remoteAccess.state().pairingCode).toBe(after.pairingCode);
  });
});

describe('RemoteAccess.revokeDevice', () => {
  it('also rotates the pairing code, so a revoked device cannot re-pair with a code it already saw', async () => {
    const { remoteAccess } = makeHarness(true);
    await remoteAccess.sync();
    const before = remoteAccess.state().pairingCode;

    const after = remoteAccess.revokeDevice('some-device-id');

    expect(after.pairingCode).not.toBe(before);
    expect(remoteAccess.state().pairingCode).toBe(after.pairingCode);
  });
});
