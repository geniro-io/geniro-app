import { join } from 'node:path';

import { app } from 'electron';

import type { DaemonHandle, Settings } from '../../shared/contracts';
import type { RemoteAccessState } from '../../shared/remote';
import type { IpcRegistry } from '../ipc-registry';
import { readSettings } from '../settings';
import { DeviceRegistry } from './device-registry';
import { type GatewayOptions, RemoteGateway } from './gateway';
import { Pairing } from './pairing';

/**
 * The subset of {@link RemoteGateway} this module drives — a seam so a spec
 * can inject a double instead of binding a real port, on the same terms every
 * other test seam in this app takes (`DaemonSupervisor`, `UpdateService`).
 */
export interface RemoteAccessGateway {
  start(): Promise<void>;
  stop(): Promise<void>;
  state(): RemoteAccessState;
}

export interface RemoteAccessOptions {
  ipcRegistry: IpcRegistry;
  daemonHandle: () => DaemonHandle | null;
  /** Electron's userData dir, as an OPTION so a spec needs no Electron. */
  userDataDir?: string;
  /** Where the packaged renderer bundle lives — see {@link GatewayOptions.staticRoot}. */
  staticRoot?: string;
  /** Vite's own dev server, mirroring `index.ts`'s `isDev` decision — see {@link GatewayOptions.devServerUrl}. */
  devServerUrl?: string;
  /**
   * Test seam for `preferredPort`/`allowedHostNames` and the like — passed
   * straight through to `RemoteGateway` when no `gateway` double is given.
   */
  gatewayOverrides?: Partial<
    Pick<GatewayOptions, 'preferredPort' | 'allowedHostNames'>
  >;
  /**
   * Injected so `regenerateCode`/`revokeDevice` and a caller-supplied
   * `gateway` double can share the same instance rather than two that
   * silently drift apart.
   */
  pairing?: Pairing;
  deviceRegistry?: DeviceRegistry;
  /** Test seam: an already-built gateway, bypassing the real one entirely. */
  gateway?: RemoteAccessGateway;
  /** Test seam for the persisted switch, so a spec never touches settings.json. */
  readSettings?: () => Pick<Settings, 'remoteAccessEnabled'>;
}

/**
 * Owns the LAN gateway's whole lifetime — construction, start/stop, and the
 * one state a spec needs — so `index.ts` stays a thin wiring list and `ipc.ts`
 * has a single object to call for all three remote-access channels.
 */
export class RemoteAccess {
  private readonly gateway: RemoteAccessGateway;
  private readonly pairing: Pairing;
  private readonly deviceRegistry: DeviceRegistry;
  private readonly readSettingsFn: () => Pick<Settings, 'remoteAccessEnabled'>;
  /**
   * The last bind failure `sync()` caught, or null. Kept separately from the
   * gateway's own `state().unavailableReason` (a generic "not listening")
   * because this is the one place that knows WHY — the caller of `sync()`
   * never sees the throw, so if the reason is not remembered here it is gone.
   */
  private unavailableReason: string | null = null;

  constructor(options: RemoteAccessOptions) {
    this.readSettingsFn = options.readSettings ?? readSettings;
    this.pairing = options.pairing ?? new Pairing();
    this.deviceRegistry =
      options.deviceRegistry ??
      new DeviceRegistry({
        filePath: join(
          options.userDataDir ?? app.getPath('userData'),
          'remote-devices.json',
        ),
      });
    this.gateway =
      options.gateway ??
      new RemoteGateway({
        pairing: this.pairing,
        deviceRegistry: this.deviceRegistry,
        ipcRegistry: options.ipcRegistry,
        daemonHandle: options.daemonHandle,
        // electron-vite bundles the WHOLE main process into one
        // `out/main/index.js` (a single rollup entry — see
        // `electron.vite.config.ts`), so this module's `__dirname` at
        // runtime is `out/main/`, identical to `index.ts`'s own — hence the
        // same one `../` `createWindow` uses to reach `out/renderer`, not two.
        staticRoot: options.staticRoot ?? join(__dirname, '../renderer'),
        devServerUrl: options.devServerUrl,
        ...options.gatewayOverrides,
      });
  }

  /**
   * Start the listener when the setting is on and it is not already up; stop
   * it when off. Idempotent — `RemoteGateway.start`/`stop` already no-op on a
   * repeat call, so calling this again with the same answer costs nothing.
   *
   * Never throws: a listener that cannot bind (the preferred port taken, a
   * sandboxed machine refusing the socket) is a DEGRADED feature — the rest
   * of the app, including the daemon and every window, must come up whatever
   * this does. The failure is instead recorded so `state()` can report it.
   */
  async sync(): Promise<void> {
    const { remoteAccessEnabled } = this.readSettingsFn();
    if (!remoteAccessEnabled) {
      // Switched off is not a failure — clear whatever an earlier bind
      // attempt left behind, or a stale reason would outlive the setting
      // that produced it and confuse the next time this is switched on.
      this.unavailableReason = null;
      await this.gateway.stop();
      return;
    }
    try {
      await this.gateway.start();
      this.unavailableReason = null;
    } catch (err) {
      this.unavailableReason = err instanceof Error ? err.message : String(err);
    }
  }

  /** Stop the listener unconditionally — app teardown, not a setting change. */
  async stop(): Promise<void> {
    await this.gateway.stop();
  }

  /**
   * What Settings draws. The gateway alone cannot answer `enabled`: it only
   * knows whether it is LISTENING, and the two differ exactly when the user
   * has switched this on and the bind failed — the one case the panel most
   * needs to show (a switch that reads "on" over a feature that is silently
   * not working). `pairingCodeExpiresAt` is filled in here because the
   * gateway's own `state()` has no access to `Pairing.codeExpiresAt()`
   * beyond what it already asks for the code itself.
   */
  state(): RemoteAccessState {
    const gatewayState = this.gateway.state();
    const { remoteAccessEnabled } = this.readSettingsFn();
    const codeExpiresAt = this.pairing.codeExpiresAt();
    return {
      ...gatewayState,
      enabled: remoteAccessEnabled,
      pairingCodeExpiresAt:
        codeExpiresAt === null ? null : new Date(codeExpiresAt).toISOString(),
      unavailableReason:
        !remoteAccessEnabled || gatewayState.listening
          ? null
          : (this.unavailableReason ?? gatewayState.unavailableReason),
    };
  }

  /** Force a new pairing code; answers the WHOLE state so the panel redraws from one reply. */
  regenerateCode(): RemoteAccessState {
    this.pairing.rotate();
    return this.state();
  }

  /**
   * Revoke a paired device; answers the WHOLE state, for the same reason as
   * {@link regenerateCode}.
   *
   * Also rotates the pairing code. Without this, a revoked device that had
   * already seen the live code (`state().pairingCode`, which a paired phone
   * can poll) could simply re-pair itself with the code it cached — Revoke
   * would remove the device's SESSION and leave the credential that produces
   * a new one standing.
   */
  revokeDevice(deviceId: string): RemoteAccessState {
    this.deviceRegistry.revoke(deviceId);
    this.pairing.rotate();
    return this.state();
  }
}
