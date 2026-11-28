// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Spinner } from './spinner';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function draw(node: React.ReactNode): Element {
  act(() => root.render(node));
  return container.firstElementChild!;
}

describe('Spinner', () => {
  it('spins a smooth arc by default', () => {
    const svg = draw(<Spinner />);
    expect(svg.classList.contains('animate-spin')).toBe(true);
    expect(svg.classList.contains('spinner-frames')).toBe(false);
    expect(svg.classList.contains('lucide-loader-circle')).toBe(true);
  });

  it('draws the same arc from the animated picture at the frames pace, with no CSS animation at all', () => {
    const spinner = draw(<Spinner pace="frames" className="size-4" />);
    expect(spinner.tagName).toBe('SPAN');
    expect(spinner.classList.contains('spinner-frames')).toBe(true);
    expect(spinner.className).not.toMatch(/animate-/);
    expect(spinner.classList.contains('text-primary')).toBe(true);
    expect(spinner.classList.contains('size-4')).toBe(true);
    expect(spinner.getAttribute('aria-hidden')).toBe('true');
    const glyph = spinner.querySelector('svg')!;
    expect(glyph.classList.contains('lucide-loader-circle')).toBe(true);
    expect(glyph.getAttribute('class')).not.toMatch(/animate-/);
  });
});

const GLOBAL_CSS = readFileSync(
  join(__dirname, '../../styles/global.css'),
  'utf8',
);
const FRAMES = join(__dirname, '../../assets/spinner-frames.webp');

function cssBlock(css: string, opener: string): string {
  const start = css.indexOf(opener);
  expect(start).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = css.indexOf('{', start); i < css.length; i += 1) {
    if (css[i] === '{') {
      depth += 1;
    }
    if (css[i] === '}') {
      depth -= 1;
    }
    if (depth === 0) {
      return css.slice(start, i + 1);
    }
  }
  throw new Error(`unclosed block after ${opener}`);
}

type WebpFrame = { duration: number; bytes: Buffer };

function webpAnimation(file: Buffer): { loops: number; frames: WebpFrame[] } {
  expect(file.toString('ascii', 0, 4)).toBe('RIFF');
  expect(file.toString('ascii', 8, 12)).toBe('WEBP');
  let loops = -1;
  const frames: WebpFrame[] = [];
  for (let at = 12; at + 8 <= file.length;) {
    const tag = file.toString('ascii', at, at + 4);
    const size = file.readUInt32LE(at + 4);
    const body = file.subarray(at + 8, at + 8 + size);
    if (tag === 'ANIM') {
      loops = body.readUInt16LE(4);
    }
    if (tag === 'ANMF') {
      frames.push({ duration: body.readUIntLE(12, 3), bytes: body });
    }
    at += 8 + size + (size % 2);
  }
  return { loops, frames };
}

describe("the frames spinner's picture", () => {
  it('masks the spinner with the animated picture, and shows the still arc instead under reduced motion', () => {
    const rule = cssBlock(GLOBAL_CSS, '.spinner-frames {');
    expect(rule).toMatch(/background-color:\s*currentColor/);
    expect(rule).toMatch(/mask:\s*url\('\.\.\/assets\/spinner-frames\.webp'\)/);
    expect(cssBlock(GLOBAL_CSS, '.spinner-frames > svg {')).toMatch(
      /visibility:\s*hidden/,
    );
    const reduced = GLOBAL_CSS.slice(GLOBAL_CSS.indexOf('.spinner-frames {'));
    const media = cssBlock(reduced, '@media (prefers-reduced-motion: reduce)');
    expect(cssBlock(media, '.spinner-frames {')).toMatch(/mask:\s*none/);
    expect(cssBlock(media, '.spinner-frames > svg {')).toMatch(
      /visibility:\s*visible/,
    );
  });

  it('turns once a second, forever, in 24 frames that each differ from the one before', () => {
    const { loops, frames } = webpAnimation(readFileSync(FRAMES));
    expect(loops).toBe(0);
    expect(frames).toHaveLength(24);
    expect(frames.reduce((sum, frame) => sum + frame.duration, 0)).toBe(1000);
    frames.forEach((frame, index) => {
      const previous = frames.at(index - 1)!;
      expect(frame.bytes.subarray(16).equals(previous.bytes.subarray(16))).toBe(
        false,
      );
    });
  });
});
