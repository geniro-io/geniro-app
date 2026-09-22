// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { QrCode } from './qr-code';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render(element: React.ReactElement): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(element);
  });
  return container;
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

describe('QrCode', () => {
  it('encodes the given value into a real, non-empty symbol', () => {
    const el = render(<QrCode value="http://geniro-mac.local:47616" />);
    const path = el.querySelector('path')!;
    // A `d` this short could not possibly encode a URL — the assertion pins
    // that the library's module matrix actually ran, not merely that some
    // path attribute exists.
    expect(path.getAttribute('d')!.length).toBeGreaterThan(50);
  });

  it('draws a DIFFERENT symbol for a different value', () => {
    const a = render(<QrCode value="http://one.local:47616/#/chats/a" />);
    const pathA = a.querySelector('path')!.getAttribute('d');
    const b = render(<QrCode value="http://two.local:47616/#/chats/b" />);
    const pathB = b.querySelector('path')!.getAttribute('d');
    expect(pathA).not.toBe(pathB);
  });

  it('is an accessible image naming the encoded value by default', () => {
    const el = render(<QrCode value="http://geniro-mac.local:47616" />);
    const svg = el.querySelector('svg')!;
    expect(svg.getAttribute('role')).toBe('img');
    expect(svg.getAttribute('aria-label')).toBe(
      'QR code for http://geniro-mac.local:47616',
    );
  });

  it('takes an explicit label over the derived one', () => {
    const el = render(
      <QrCode value="http://geniro-mac.local:47616" label="Pairing link" />,
    );
    expect(el.querySelector('svg')!.getAttribute('aria-label')).toBe(
      'Pairing link',
    );
  });

  it('renders at the requested pixel size', () => {
    const el = render(
      <QrCode value="http://geniro-mac.local:47616" size={64} />,
    );
    const svg = el.querySelector('svg')!;
    expect(svg.getAttribute('width')).toBe('64');
    expect(svg.getAttribute('height')).toBe('64');
  });

  it('draws the ink and paper from the strongest token pair, never a literal colour', () => {
    const el = render(<QrCode value="http://geniro-mac.local:47616" />);
    expect(el.querySelector('rect')!.getAttribute('fill')).toBe(
      'var(--background)',
    );
    expect(el.querySelector('path')!.getAttribute('fill')).toBe(
      'var(--foreground)',
    );
  });
});
