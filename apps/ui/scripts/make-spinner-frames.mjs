import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LoaderCircle } from 'lucide-react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const FRAMES = Number(process.argv[2] ?? 24);
const PIXELS = 48;
const TURN_MS = 1000;
const OUT = join(
  import.meta.dirname,
  '../src/renderer/assets/spinner-frames.webp',
);

const icon = /^(<svg[^>]*>)(.*)(<\/svg>)$/s.exec(
  renderToStaticMarkup(
    createElement(LoaderCircle, { size: 24, color: '#000', strokeWidth: 2 }),
  ),
);
if (!icon) {
  throw new Error('LoaderCircle did not render as one <svg> element');
}
const [, open, shapes, close] = icon;

const dir = mkdtempSync(join(tmpdir(), 'spinner-frames-'));
try {
  const args = ['-loop', '0', '-lossless', '-exact'];
  let elapsed = 0;
  for (let index = 0; index < FRAMES; index += 1) {
    const angle = (360 / FRAMES) * index;
    const svg = join(dir, `${index}.svg`);
    const png = join(dir, `${index}.png`);
    writeFileSync(
      svg,
      `${open}<g transform="rotate(${angle} 12 12)">${shapes}</g>${close}`,
    );
    execFileSync('rsvg-convert', [
      '-w',
      String(PIXELS),
      '-h',
      String(PIXELS),
      '-o',
      png,
      svg,
    ]);
    const end = Math.round((TURN_MS * (index + 1)) / FRAMES);
    args.push('-d', String(end - elapsed), png);
    elapsed = end;
  }
  execFileSync('img2webp', [...args, '-o', OUT], { stdio: 'inherit' });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
