import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ARC = 'M21 12a9 9 0 1 1-6.219-8.56';
const FRAMES = Number(process.argv[2] ?? 24);
const PIXELS = 48;
const TURN_MS = 1000;
const OUT = join(import.meta.dirname, '../src/renderer/assets/spinner-frames.webp');

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
      `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path transform="rotate(${angle} 12 12)" d="${ARC}"/></svg>`,
    );
    execFileSync('rsvg-convert', ['-w', String(PIXELS), '-h', String(PIXELS), '-o', png, svg]);
    const end = Math.round((TURN_MS * (index + 1)) / FRAMES);
    args.push('-d', String(end - elapsed), png);
    elapsed = end;
  }
  execFileSync('img2webp', [...args, '-o', OUT], { stdio: 'inherit' });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
