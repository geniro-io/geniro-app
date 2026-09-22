// @vitest-environment jsdom
import * as QRCode from 'qrcode';
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type RemoteAccessState, TUNNEL_OFF } from '../../shared/remote';
import { createPreloadStub } from '../__fixtures__/preload-stub';
import { RemoteAccess } from './remote-access';

/**
 * The same `d` attribute `QrCode` would draw for `value` — built straight
 * from the library's own module matrix, exactly as the component does, so
 * this pins WHICH url is encoded rather than merely that some symbol is.
 */
function qrPathFor(value: string): string {
  const modules = QRCode.create(value, { errorCorrectionLevel: 'M' }).modules;
  let d = '';
  for (let row = 0; row < modules.size; row += 1) {
    for (let col = 0; col < modules.size; col += 1) {
      if (modules.get(row, col)) {
        d += `M${col},${row}h1v1h-1z`;
      }
    }
  }
  return d;
}

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const OFF: RemoteAccessState = {
  enabled: false,
  listening: false,
  port: null,
  hostUrl: null,
  addressUrl: null,
  pairingCode: null,
  pairingCodeExpiresAt: null,
  devices: [],
  unavailableReason: null,
  tunnel: TUNNEL_OFF,
};

const NOT_LISTENING: RemoteAccessState = {
  ...OFF,
  enabled: true,
  unavailableReason: 'Port 47616 is already in use and no fallback was free.',
};

const LISTENING: RemoteAccessState = {
  enabled: true,
  listening: true,
  port: 47616,
  hostUrl: 'http://geniro-mac.local:47616',
  addressUrl: 'http://192.168.1.42:47616',
  pairingCode: '482917',
  pairingCodeExpiresAt: '2026-09-21T12:30:00.000Z',
  devices: [
    {
      id: 'device-1',
      tokenHash: 'hash-1',
      label: 'iPhone — Safari',
      pairedAt: '2026-09-20T12:00:00.000Z',
      lastSeenAt: '2026-09-21T11:00:00.000Z',
    },
  ],
  unavailableReason: null,
  tunnel: TUNNEL_OFF,
};

const geniro = {
  getRemoteAccess: vi.fn(),
  updateSettings: vi.fn(),
  regenerateRemotePairingCode: vi.fn(),
  revokeRemoteDevice: vi.fn(),
  startRemoteTunnel: vi.fn(),
  stopRemoteTunnel: vi.fn(),
};

let container: HTMLDivElement;
let root: Root | null;

async function mount(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  const mountedRoot = createRoot(container);
  root = mountedRoot;
  await act(async () => {
    mountedRoot.render(<RemoteAccess />);
  });
}

beforeEach(() => {
  geniro.getRemoteAccess.mockReset().mockResolvedValue(OFF);
  geniro.updateSettings.mockReset().mockResolvedValue({});
  geniro.regenerateRemotePairingCode.mockReset().mockResolvedValue(LISTENING);
  geniro.revokeRemoteDevice.mockReset().mockResolvedValue(LISTENING);
  geniro.startRemoteTunnel.mockReset().mockResolvedValue(LISTENING);
  geniro.stopRemoteTunnel.mockReset().mockResolvedValue(LISTENING);
  window.geniro = createPreloadStub(geniro);
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
  }
  container.remove();
});

describe('RemoteAccess', () => {
  it('reflects the switch off and shows none of the listening-only panels', async () => {
    await mount();
    const toggle = container.querySelector('#settings-remote-access')!;
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(container.textContent).not.toContain('Pairing code');
  });

  it('explains an on-but-not-listening state with the daemon-given reason', async () => {
    geniro.getRemoteAccess.mockResolvedValue(NOT_LISTENING);
    await mount();
    expect(container.textContent).toContain(
      'Port 47616 is already in use and no fallback was free.',
    );
    // Still nothing to copy or scan — there is no link to show.
    expect(container.textContent).not.toContain('Pairing code');
  });

  it('shows both links, the QR for the primary one, the code and its devices once listening', async () => {
    geniro.getRemoteAccess.mockResolvedValue(LISTENING);
    await mount();
    expect(container.textContent).toContain('http://geniro-mac.local:47616');
    expect(container.textContent).toContain('http://192.168.1.42:47616');
    // The QR is labelled with a fixed instruction rather than the URL, so the
    // encoded VALUE is what pins which link it is — the primary (.local) one,
    // never the fallback.
    const qr = container.querySelector('svg[role="img"]')!;
    expect(qr.getAttribute('aria-label')).toBe(
      'Scan to open this device’s link on your phone',
    );
    const primaryPath = qrPathFor('http://geniro-mac.local:47616');
    const fallbackPath = qrPathFor('http://192.168.1.42:47616');
    expect(qr.querySelector('path')!.getAttribute('d')).toBe(primaryPath);
    expect(qr.querySelector('path')!.getAttribute('d')).not.toBe(fallbackPath);
    expect(container.textContent).toContain('482917');
    expect(container.textContent).toContain('iPhone — Safari');
  });

  it('flips the switch, persists it and re-reads the whole state', async () => {
    geniro.getRemoteAccess
      .mockResolvedValueOnce(OFF)
      .mockResolvedValueOnce(LISTENING);
    await mount();
    const toggle = container.querySelector(
      '#settings-remote-access',
    ) as HTMLButtonElement;
    await act(async () => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(geniro.updateSettings).toHaveBeenCalledWith({
      remoteAccessEnabled: true,
    });
    // Re-fetched rather than assumed on: enabling the setting does not by
    // itself mean the gateway bound its port.
    expect(geniro.getRemoteAccess).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('482917');
  });

  it('rolls the switch back when the write is refused', async () => {
    geniro.getRemoteAccess.mockResolvedValue(OFF);
    geniro.updateSettings.mockRejectedValue(new Error('refused'));
    await mount();
    const toggle = container.querySelector(
      '#settings-remote-access',
    ) as HTMLButtonElement;
    await act(async () => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(container.textContent).toContain('refused');
  });

  it('regenerates the pairing code and redraws from the reply', async () => {
    geniro.getRemoteAccess.mockResolvedValue(LISTENING);
    geniro.regenerateRemotePairingCode.mockResolvedValue({
      ...LISTENING,
      pairingCode: '110033',
    });
    await mount();
    const regenerate = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Regenerate'),
    )!;
    await act(async () => {
      regenerate.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(geniro.regenerateRemotePairingCode).toHaveBeenCalled();
    expect(container.textContent).toContain('110033');
    expect(container.textContent).not.toContain('482917');
  });

  it('revokes the pressed device by its id and redraws the device list', async () => {
    geniro.getRemoteAccess.mockResolvedValue(LISTENING);
    geniro.revokeRemoteDevice.mockResolvedValue({ ...LISTENING, devices: [] });
    await mount();
    const revoke = container.querySelector(
      'button[aria-label="Revoke iPhone — Safari"]',
    ) as HTMLButtonElement;
    await act(async () => {
      revoke.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(geniro.revokeRemoteDevice).toHaveBeenCalledWith('device-1');
    expect(container.textContent).toContain('None yet');
  });
});

describe('RemoteAccess under StrictMode', () => {
  // React's StrictMode deliberately runs mount -> cleanup -> mount. A
  // `mountedRef` that is only ever CLEARED in the cleanup is left false by
  // that rehearsal, after which every `setState` this panel makes is
  // skipped and the switch reads off and disabled whatever the gateway is
  // really doing. Driving the real app is what found it; this is what keeps
  // it found.
  it('still shows live state after the double-invoked mount effect', async () => {
    geniro.getRemoteAccess.mockReset().mockResolvedValue(LISTENING);
    const strictContainer = document.createElement('div');
    document.body.appendChild(strictContainer);
    const strictRoot = createRoot(strictContainer);
    await act(async () => {
      strictRoot.render(
        <StrictMode>
          <RemoteAccess />
        </StrictMode>,
      );
    });

    // The live pairing code only renders once `setState` actually landed.
    expect(strictContainer.textContent).toContain(LISTENING.pairingCode!);

    await act(async () => strictRoot.unmount());
    strictContainer.remove();
  });
});

describe('RemoteAccess — the public address', () => {
  const OPEN: RemoteAccessState = {
    ...LISTENING,
    tunnel: {
      status: 'open',
      provider: 'cloudflared',
      url: 'https://keyword-portsmouth.trycloudflare.com',
      error: null,
    },
  };

  /** The panel's one button, whichever of its two states it is in. */
  function tunnelButton(): HTMLButtonElement {
    const button = [...container.querySelectorAll('button')].find((el) =>
      /Get an address|Close address/.test(el.textContent ?? ''),
    );
    if (!button) {
      throw new Error('expected the tunnel button to be rendered');
    }
    return button;
  }

  it('offers the press only once the gateway is listening', async () => {
    geniro.getRemoteAccess.mockResolvedValue(NOT_LISTENING);
    await mount();
    // A tunnel forwards to this listener, so there is nothing to publish.
    expect(container.textContent).not.toContain('Get an address');
  });

  it('opens an address on the press, and redraws from the one reply', async () => {
    geniro.getRemoteAccess.mockResolvedValue(LISTENING);
    geniro.startRemoteTunnel.mockResolvedValue(OPEN);
    await mount();

    await act(async () => tunnelButton().click());

    expect(geniro.startRemoteTunnel).toHaveBeenCalledOnce();
    expect(container.textContent).toContain(
      'https://keyword-portsmouth.trycloudflare.com',
    );
  });

  it('encodes the PUBLIC url in a QR of its own, beside the LAN one', async () => {
    geniro.getRemoteAccess.mockResolvedValue(OPEN);
    await mount();

    const labels = [...container.querySelectorAll('svg[role="img"]')].map(
      (qr) => qr.getAttribute('aria-label'),
    );
    expect(labels).toContain('Scan to open the public link on your phone');

    const publicQr = [...container.querySelectorAll('svg[role="img"]')].find(
      (qr) =>
        qr.getAttribute('aria-label') ===
        'Scan to open the public link on your phone',
    )!;
    // Pins WHICH url is encoded — the tunnel's, never the `.local` one.
    expect(publicQr.querySelector('path')!.getAttribute('d')).toBe(
      qrPathFor('https://keyword-portsmouth.trycloudflare.com'),
    );
  });

  it('closes it on the second press, through the other channel', async () => {
    geniro.getRemoteAccess.mockResolvedValue(OPEN);
    geniro.stopRemoteTunnel.mockResolvedValue(LISTENING);
    await mount();

    await act(async () => tunnelButton().click());

    expect(geniro.stopRemoteTunnel).toHaveBeenCalledOnce();
    expect(geniro.startRemoteTunnel).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain(
      'https://keyword-portsmouth.trycloudflare.com',
    );
  });

  it('shows the tunnel client’s own words when it refuses', async () => {
    geniro.getRemoteAccess.mockResolvedValue({
      ...LISTENING,
      tunnel: {
        status: 'error',
        provider: 'ngrok',
        url: null,
        error: 'ngrok stopped (exit 1): authentication failed',
      },
    } satisfies RemoteAccessState);
    await mount();

    // The failure the user can act on is the CLIENT's, not a generic one —
    // an expired authtoken names its own fix.
    expect(container.textContent).toContain('authentication failed');
  });
});
