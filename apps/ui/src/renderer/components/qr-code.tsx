import * as QRCode from 'qrcode';
import { useMemo } from 'react';

import { cn } from './ui/utils';

/**
 * How many blank modules ring the symbol.
 *
 * The quiet zone is part of what a scanner reads, not outer CSS padding a
 * caller could strip — a camera uses it to find the code's edges in the first
 * place — so it rides inside this component's own `viewBox` rather than being
 * left to whoever places the element.
 */
const QUIET_ZONE_MODULES = 4;

/**
 * A URL rendered as a scannable QR code, as inline SVG drawn straight from the
 * library's own module matrix (`QRCode.create`) rather than through its
 * PNG/SVG renderers — so every mark is `var(--token)` and nothing here ever
 * needs a colour literal to draw a pixel.
 *
 * Deliberately the one place in this renderer that reaches for the palette's
 * strongest pair — `--foreground` on `--background` — rather than the muted,
 * low-contrast tones every other surface is built from: a phone camera reads
 * this from arm's length in whatever light the room has, and the app's usual
 * ink-on-cream body-text contrast is tuned for a screen a few centimetres
 * from an eye, below what a scanner can resolve.
 */
export function QrCode({
  value,
  size = 168,
  label,
  className,
}: {
  /** The exact text encoded — a URL, always, for every caller in this app. */
  value: string;
  /** Rendered pixel size — the symbol is always square. */
  size?: number;
  /** Accessible name; defaults to naming the encoded value. */
  label?: string;
  className?: string;
}): React.JSX.Element {
  // `errorCorrectionLevel: 'M'` (~15% recoverable) is the library's own
  // default, kept explicit rather than assumed: a lower level fails a phone
  // held at an angle, and a higher one enlarges the symbol for redundancy this
  // component's one job — one short URL — never needs.
  const modules = useMemo(
    () => QRCode.create(value, { errorCorrectionLevel: 'M' }).modules,
    [value],
  );
  const path = useMemo(() => {
    let d = '';
    for (let row = 0; row < modules.size; row += 1) {
      for (let col = 0; col < modules.size; col += 1) {
        if (modules.get(row, col)) {
          d += `M${col},${row}h1v1h-1z`;
        }
      }
    }
    return d;
  }, [modules]);
  const dimension = modules.size + QUIET_ZONE_MODULES * 2;

  return (
    <svg
      role="img"
      aria-label={label ?? `QR code for ${value}`}
      width={size}
      height={size}
      viewBox={`0 0 ${dimension} ${dimension}`}
      shapeRendering="crispEdges"
      className={cn('shrink-0', className)}>
      <rect width={dimension} height={dimension} fill="var(--background)" />
      <path
        d={path}
        transform={`translate(${QUIET_ZONE_MODULES} ${QUIET_ZONE_MODULES})`}
        fill="var(--foreground)"
      />
    </svg>
  );
}
