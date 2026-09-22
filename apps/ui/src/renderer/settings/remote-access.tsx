import { Globe, Loader2, RefreshCw, Smartphone, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { RemoteAccessState } from '../../shared/remote';
import { formatRelativeTime } from '../chats/relative-time';
import { CopyButton } from '../components/copy-button';
import { ErrorText } from '../components/error-text';
import { QrCode } from '../components/qr-code';
import { SettingsPanel, SettingsPanelRow } from '../components/settings-panel';
import { Button } from '../components/ui/button';
import { Switch } from '../components/ui/switch';

/**
 * One copyable link — the `.local` primary or the IP fallback.
 *
 * Both are shown because neither works everywhere ({@link RemoteAccessState}'s
 * own doc): a `.local` name needs mDNS, which some Android builds and some
 * guest networks refuse to resolve, and the IP is the fallback for exactly
 * that case.
 */
function RemoteLinkRow({
  label,
  url,
}: {
  label: string;
  url: string;
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className="truncate font-mono text-sm" title={url}>
          {url}
        </span>
      </div>
      <CopyButton text={url} label={`Copy ${label.toLowerCase()}`} />
    </div>
  );
}

/**
 * The public address, and the one press that opens or closes it.
 *
 * Its own panel rather than a third row beside the LAN links, because it is a
 * different promise: those two describe a listener anyone on the Wi-Fi can
 * already reach, while this one describes a tunnel client geniro starts on
 * demand and stops again. It is a PRESS and never a switch geniro flips for
 * itself — see `main/remote/tunnel.ts`.
 */
function TunnelPanel({
  tunnel,
  onOpen,
  onClose,
  pending,
}: {
  tunnel: RemoteAccessState['tunnel'];
  onOpen: () => void;
  onClose: () => void;
  pending: boolean;
}): React.JSX.Element {
  const busy = pending || tunnel.status === 'starting';
  return (
    <SettingsPanel>
      <SettingsPanelRow
        layout="block"
        label="Internet address"
        description="Runs a tunnel client on this Mac (cloudflared, else ngrok) and forwards a public address to it. Anyone with the link reaches the pairing screen, so the 6-digit code becomes the only thing in front of your agents.">
        <div className="flex flex-col gap-2">
          {tunnel.status === 'open' && tunnel.url ? (
            <RemoteLinkRow
              label={`Public (via ${tunnel.provider ?? 'tunnel'})`}
              url={tunnel.url}
            />
          ) : null}
          {tunnel.status === 'error' && tunnel.error ? (
            <ErrorText>{tunnel.error}</ErrorText>
          ) : null}
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant={tunnel.status === 'open' ? 'outline' : 'default'}
              size="sm"
              className="shrink-0 gap-1.5"
              disabled={busy}
              onClick={tunnel.status === 'open' ? onClose : onOpen}>
              {busy ? (
                <Loader2
                  aria-hidden="true"
                  className="size-3.5 shrink-0 animate-spin"
                />
              ) : (
                <Globe aria-hidden="true" className="size-3.5 shrink-0" />
              )}
              {tunnel.status === 'open' ? 'Close address' : 'Get an address'}
            </Button>
            {tunnel.status === 'starting' ? (
              <span className="text-xs text-muted-foreground">
                Waiting for the tunnel to report its address…
              </span>
            ) : null}
          </div>
        </div>
      </SettingsPanelRow>
      {tunnel.status === 'open' && tunnel.url ? (
        <SettingsPanelRow layout="block">
          <div className="flex items-center gap-3">
            <QrCode
              value={tunnel.url}
              size={144}
              label="Scan to open the public link on your phone"
            />
            <p className="text-xs text-muted-foreground">
              Works from any network, not just this Wi-Fi. The address changes
              every time you open one.
            </p>
          </div>
        </SettingsPanelRow>
      ) : null}
    </SettingsPanel>
  );
}

/**
 * One device that has paired, with when it was last seen and a way to kick it
 * off.
 */
function DeviceRow({
  device,
  onRevoke,
  revoking,
}: {
  device: RemoteAccessState['devices'][number];
  onRevoke: (deviceId: string) => void;
  revoking: boolean;
}): React.JSX.Element {
  return (
    <li
      data-slot="remote-device-row"
      className="flex items-center gap-2 rounded-lg border border-border bg-card px-2 py-1.5">
      <Smartphone
        aria-hidden="true"
        className="size-3.5 shrink-0 text-muted-foreground"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm" title={device.label}>
          {device.label}
        </span>
        <span className="text-xs text-muted-foreground">
          Last seen {formatRelativeTime(device.lastSeenAt)} · paired{' '}
          {formatRelativeTime(device.pairedAt)}
        </span>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
        aria-label={`Revoke ${device.label}`}
        title={`Revoke ${device.label} — it will have to pair again`}
        disabled={revoking}
        onClick={() => onRevoke(device.id)}>
        {revoking ? (
          <Loader2
            aria-hidden="true"
            className="size-3.5 shrink-0 animate-spin"
          />
        ) : (
          <Trash2 aria-hidden="true" className="size-3.5 shrink-0" />
        )}
      </Button>
    </li>
  );
}

/**
 * Settings → Remote access — the one screen that shows and controls the LAN
 * gateway (`main/remote/`, see the root `CLAUDE.md` → *Constraints*).
 *
 * It reads its whole picture from ONE call, {@link RemoteAccessState}, and
 * every mutating action (the switch, Regenerate, Revoke) re-reads it rather
 * than patching local state — the state is small, it is shared with a paired
 * PHONE reading the identical shape over the gateway's own bridge, and a
 * hand-folded patch here is a second copy of logic the daemon-analogous main
 * process already has to get right once.
 */
export function RemoteAccess(): React.JSX.Element {
  const [state, setState] = useState<RemoteAccessState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  // The switch flips at once, before the round trip answers — a toggle that
  // waited for `updateSettings` to resolve before moving would read as an
  // unresponsive control on a slow launch.
  const [togglePending, setTogglePending] = useState(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    // Re-armed in the effect BODY, not only cleared in the cleanup. React's
    // StrictMode runs mount → cleanup → mount, so a cleanup-only version
    // leaves this false for the rest of the component's life and every later
    // `setState` is skipped — the panel then shows the switch off and
    // disabled no matter what the gateway is actually doing, which is what
    // driving the real app found.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback((): void => {
    void window.geniro.getRemoteAccess().then((next) => {
      if (mountedRef.current) {
        setState(next);
      }
    });
  }, []);

  useEffect(refresh, [refresh]);

  const onToggle = useCallback(
    (next: boolean): void => {
      setError(null);
      setTogglePending(true);
      // Optimistic, on the same reasoning every other switch in this screen's
      // parent follows — the write is a settings patch keyed by ONE field, so
      // a refusal is a genuine surprise rather than the common case.
      setState((prev) => (prev ? { ...prev, enabled: next } : prev));
      void window.geniro
        .updateSettings({ remoteAccessEnabled: next })
        .then(() => {
          // The GATEWAY takes a moment to bind or tear down its listener, so
          // the freshly-fetched state is what says whether it is actually
          // LISTENING — `enabled` alone would read "on" the instant before a
          // bind failure sets `unavailableReason`.
          if (mountedRef.current) {
            refresh();
          }
        })
        .catch((err: unknown) => {
          if (!mountedRef.current) {
            return;
          }
          setState((prev) => (prev ? { ...prev, enabled: !next } : prev));
          setError(String(err));
        })
        .finally(() => {
          if (mountedRef.current) {
            setTogglePending(false);
          }
        });
    },
    [refresh],
  );

  const onRegenerate = useCallback((): void => {
    setError(null);
    setRegenerating(true);
    void window.geniro
      .regenerateRemotePairingCode()
      .then((next) => {
        if (mountedRef.current) {
          setState(next);
        }
      })
      .catch((err: unknown) => {
        if (mountedRef.current) {
          setError(String(err));
        }
      })
      .finally(() => {
        if (mountedRef.current) {
          setRegenerating(false);
        }
      });
  }, []);

  // ONE flag for both presses: opening and closing are the same control in
  // two states, so a second flag could only ever describe a press that is not
  // the one on screen.
  const [tunnelPending, setTunnelPending] = useState(false);
  const runTunnel = useCallback(
    (call: () => Promise<RemoteAccessState>): void => {
      setError(null);
      setTunnelPending(true);
      void call()
        .then((next) => {
          if (mountedRef.current) {
            setState(next);
          }
        })
        .catch((err: unknown) => {
          if (mountedRef.current) {
            setError(String(err));
          }
        })
        .finally(() => {
          if (mountedRef.current) {
            setTunnelPending(false);
          }
        });
    },
    [],
  );

  const onRevoke = useCallback((deviceId: string): void => {
    setError(null);
    setRevokingId(deviceId);
    void window.geniro
      .revokeRemoteDevice(deviceId)
      .then((next) => {
        if (mountedRef.current) {
          setState(next);
        }
      })
      .catch((err: unknown) => {
        if (mountedRef.current) {
          setError(String(err));
        }
      })
      .finally(() => {
        if (mountedRef.current) {
          setRevokingId(null);
        }
      });
  }, []);

  return (
    <div data-slot="remote-access" className="flex flex-col gap-3">
      {error ? <ErrorText>{error}</ErrorText> : null}

      <SettingsPanel>
        <SettingsPanelRow
          label="Remote access"
          htmlFor="settings-remote-access"
          description="Serves this app to your Wi-Fi so a phone can open the same live chats. Off, the port is never opened at all.">
          <Switch
            id="settings-remote-access"
            checked={state?.enabled ?? false}
            disabled={state === null || togglePending}
            onCheckedChange={onToggle}
          />
        </SettingsPanelRow>
        {/* Exactly the state `enabled`/`listening` are two fields for: the
            switch is on and the port never bound. */}
        {state?.enabled && !state.listening && state.unavailableReason ? (
          <SettingsPanelRow layout="block">
            <ErrorText>{state.unavailableReason}</ErrorText>
          </SettingsPanelRow>
        ) : null}
      </SettingsPanel>

      {state?.enabled && state.listening ? (
        <>
          <SettingsPanel>
            <SettingsPanelRow layout="block" label="Links">
              <div className="flex flex-col gap-2">
                {state.hostUrl ? (
                  <RemoteLinkRow
                    label="This device (.local)"
                    url={state.hostUrl}
                  />
                ) : null}
                {state.addressUrl ? (
                  <RemoteLinkRow
                    label="This device (IP address, if .local doesn’t resolve)"
                    url={state.addressUrl}
                  />
                ) : null}
              </div>
            </SettingsPanelRow>
            {state.hostUrl ? (
              <SettingsPanelRow layout="block">
                <div className="flex items-center gap-3">
                  <QrCode
                    value={state.hostUrl}
                    size={144}
                    label="Scan to open this device’s link on your phone"
                  />
                  <p className="text-xs text-muted-foreground">
                    Scan with your phone’s camera to open the primary link — the
                    real workflow is scanning this rather than retyping it.
                  </p>
                </div>
              </SettingsPanelRow>
            ) : null}
          </SettingsPanel>

          <TunnelPanel
            tunnel={state.tunnel}
            pending={tunnelPending}
            onOpen={() => runTunnel(() => window.geniro.startRemoteTunnel())}
            onClose={() => runTunnel(() => window.geniro.stopRemoteTunnel())}
          />

          <SettingsPanel>
            <SettingsPanelRow layout="block" label="Pairing code">
              <div className="flex items-center justify-between gap-3">
                <div className="flex flex-col gap-0.5">
                  {state.pairingCode ? (
                    <span className="font-mono text-3xl tracking-[0.3em] tabular-nums">
                      {state.pairingCode}
                    </span>
                  ) : (
                    <span className="text-sm text-muted-foreground">
                      No code yet
                    </span>
                  )}
                  <span className="text-xs text-muted-foreground">
                    {state.pairingCodeExpiresAt
                      ? `A new device types this. Rotates at ${new Date(
                          state.pairingCodeExpiresAt,
                        ).toLocaleTimeString([], {
                          hour: 'numeric',
                          minute: '2-digit',
                        })}.`
                      : 'A new device types this.'}
                  </span>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="shrink-0 gap-1.5"
                  disabled={regenerating}
                  onClick={onRegenerate}>
                  {regenerating ? (
                    <Loader2
                      aria-hidden="true"
                      className="size-3.5 shrink-0 animate-spin"
                    />
                  ) : (
                    <RefreshCw
                      aria-hidden="true"
                      className="size-3.5 shrink-0"
                    />
                  )}
                  Regenerate
                </Button>
              </div>
            </SettingsPanelRow>
          </SettingsPanel>

          <SettingsPanel>
            <SettingsPanelRow layout="block" label="Paired devices">
              {state.devices.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  None yet — a device pairs by typing the code above.
                </p>
              ) : (
                <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                  {state.devices.map((device) => (
                    <DeviceRow
                      key={device.id}
                      device={device}
                      onRevoke={onRevoke}
                      revoking={revokingId === device.id}
                    />
                  ))}
                </ul>
              )}
            </SettingsPanelRow>
          </SettingsPanel>
        </>
      ) : null}
    </div>
  );
}
