import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const CSS = readFileSync(join(__dirname, 'global.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function ruleBody(selector: string): string {
  const rule = new RegExp(`${escapeRegExp(selector)}\\s*\\{([^}]*)\\}`);
  return CSS.match(rule)?.[1] ?? '';
}

function keyframeIntervals(name: string): number {
  const body =
    CSS.match(new RegExp(`@keyframes ${name}\\s*\\{([\\s\\S]*?)\\n\\}`))?.[1] ??
    '';
  const offsets = new Set<number>([0, 100]);
  for (const [, stops = ''] of body.matchAll(/([^{}]+)\{/g)) {
    for (const stop of stops.split(',')) {
      const offset = stop.trim();
      if (offset === 'from') {
        offsets.add(0);
      } else if (offset === 'to') {
        offsets.add(100);
      } else if (offset.endsWith('%')) {
        offsets.add(Number.parseFloat(offset));
      }
    }
  }
  return offsets.size - 1;
}

function updatesPerSecond(selector: string): number {
  const shorthand =
    ruleBody(selector).match(/animation:\s*([^;]+);/)?.[1] ?? '';
  const [name = '', duration = '', timing = ''] = shorthand.trim().split(/\s+/);
  const steps = Number(timing.match(/^steps\((\d+)\)$/)?.[1]);
  const [, value = '', unit = ''] = duration.match(/^([\d.]+)(ms|s)$/) ?? [];
  const seconds = Number(value) * (unit === 'ms' ? 0.001 : 1);
  return (steps * keyframeIntervals(name)) / seconds;
}

describe('command center loops', () => {
  it.each([
    ['.cc-running-border::before', 24],
    ['.cc-wire-flow', 24],
    ['.cc-wire-flow-back', 24],
    ['.cc-wire-drift', 6],
    ['.cc-breathe-primary', 12],
    ['.cc-breathe-warning', 12],
  ])('%s steps to about %i updates a second', (selector, perSecond) => {
    expect(
      Math.abs(updatesPerSecond(selector) - perSecond),
    ).toBeLessThanOrEqual(1);
  });
});
