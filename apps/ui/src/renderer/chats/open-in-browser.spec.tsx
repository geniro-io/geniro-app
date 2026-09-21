// @vitest-environment jsdom
import * as QRCode from 'qrcode';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RemoteAccessState } from '../../shared/remote';
import { createPreloadStub } from '../__fixtures__/preload-stub';
import { OpenInBrowser } from './open-in-browser';

/**
 * The same `d` attribute `QrCode` would draw for `value` — see the twin of
 * this helper in `settings/remote-access.spec.tsx` for why it is built this
 * way rather than read off the label.
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
};

const NOT_LISTENING: RemoteAccessState = {
  ...OFF,
  enabled: true,
  unavailableReason: 'No free port could be bound.',
};

const LISTENING: RemoteAccessState = {
  enabled: true,
  listening: true,
  port: 47616,
  hostUrl: 'http://geniro-mac.local:47616',
  addressUrl: 'http://192.168.1.42:47616',
  pairingCode: '482917',
  pairingCodeExpiresAt: '2026-09-21T12:30:00.000Z',
  devices: [],
  unavailableReason: null,
};

const geniro = { getRemoteAccess: vi.fn() };

let container: HTMLDivElement;
let root: Root | null;

async function mount(runId: string | null): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  const mountedRoot = createRoot(container);
  root = mountedRoot;
  await act(async () => {
    mountedRoot.render(<OpenInBrowser runId={runId} />);
  });
}

/** Click the trigger to PIN the panel open — `HoverPopover`'s press path. */
async function openPanel(): Promise<void> {
  const trigger = container.querySelector('button')!;
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
  });
}

beforeEach(() => {
  geniro.getRemoteAccess.mockReset().mockResolvedValue(OFF);
  window.geniro = createPreloadStub(geniro);
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
  }
  container.remove();
});

describe('OpenInBrowser', () => {
  it('draws nothing when no thread is open', async () => {
    await mount(null);
    expect(container.querySelector('button')).toBeNull();
  });

  it('draws the trigger for an open thread even before remote access is known', async () => {
    let resolveFetch: ((state: RemoteAccessState) => void) | undefined;
    geniro.getRemoteAccess.mockReturnValue(
      new Promise<RemoteAccessState>((resolve) => {
        resolveFetch = resolve;
      }),
    );
    await mount('run-1');
    expect(container.querySelector('button')).not.toBeNull();
    await act(async () => {
      resolveFetch?.(OFF);
      await Promise.resolve();
    });
  });

  it('says remote access is off rather than doing nothing on press', async () => {
    geniro.getRemoteAccess.mockResolvedValue(OFF);
    await mount('run-1');
    await openPanel();
    expect(container.textContent).toContain('Remote access is off');
  });

  it('shows the daemon-given reason when on but not listening', async () => {
    geniro.getRemoteAccess.mockResolvedValue(NOT_LISTENING);
    await mount('run-1');
    await openPanel();
    expect(container.textContent).toContain('No free port could be bound.');
  });

  it('builds the thread link from the primary host and this run’s route, and offers to copy, scan and open it', async () => {
    geniro.getRemoteAccess.mockResolvedValue(LISTENING);
    await mount('run-1');
    await openPanel();
    const expected = 'http://geniro-mac.local:47616#/chats/run-1';
    expect(container.textContent).toContain(expected);
    // The label is a fixed instruction, not the URL — the encoded VALUE is
    // what pins that this is THIS thread's link, built from its own runId.
    const qr = container.querySelector('svg[role="img"]')!;
    expect(qr.querySelector('path')!.getAttribute('d')).toBe(
      qrPathFor(expected),
    );
    const openLink = container.querySelector(
      'a[aria-label="Open this thread in your browser"]',
    ) as HTMLAnchorElement;
    expect(openLink.getAttribute('href')).toBe(expected);
    expect(openLink.getAttribute('target')).toBe('_blank');
    expect(
      container.querySelector('button[aria-label="Copy thread link"]'),
    ).not.toBeNull();
  });

  it('falls back to the address link when the .local link is absent, rather than reporting nothing is listening', async () => {
    geniro.getRemoteAccess.mockResolvedValue({
      ...LISTENING,
      hostUrl: null,
    });
    await mount('run-1');
    await openPanel();
    expect(container.textContent).toContain(
      'http://192.168.1.42:47616#/chats/run-1',
    );
  });
});
