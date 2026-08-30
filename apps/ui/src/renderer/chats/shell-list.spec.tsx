// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ShellRun } from './shell-activity';
import { ShellRows } from './shell-list';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;

const shell = (over: Partial<ShellRun> = {}): ShellRun =>
  ({
    id: 'c1',
    command: 'sleep 400',
    description: null,
    background: false,
    handle: null,
    status: 'running',
    exitCode: null,
    startedAt: new Date(Date.now() - 8_000).toISOString(),
    agentId: null,
    ...over,
  }) as ShellRun;

function render(shells: ShellRun[]): HTMLElement {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root.render(<ShellRows shells={shells} />);
  });
  return container;
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('ShellRows', () => {
  it('draws ONE line per command: glyph, command, tag, clock', () => {
    const el = render([shell({ background: true })]);
    const row = el.querySelector('[data-slot="shell-row"]')!;

    // The parts, in order. There is deliberately no caption over them — the
    // band used to carry `1 shell running`, which on the commonest case was a
    // whole line counting the single line beneath it.
    expect(row.querySelector('svg')).not.toBeNull();
    expect(row.textContent).toContain('sleep 400');
    expect(row.textContent).toContain('background');
    expect(row.textContent).toMatch(/\d+s/);
  });

  it('says `background` in a WORD, never the `BG` it read as', () => {
    // Two letters of shell jargon, set in the same muted grey as the clock,
    // made the one row carrying an explanation the one nobody could decode.
    const detached = render([shell({ background: true })]).querySelector(
      '[data-shell-background="true"]',
    )!;
    expect(detached.textContent).toContain('background');
    expect(detached.textContent).not.toContain('BG');
  });

  it('marks only a DETACHED command, so a foreground one carries no tag', () => {
    const el = render([shell()]);
    expect(el.textContent).not.toContain('background');
    expect(el.querySelector('[data-shell-background="false"]')).not.toBeNull();
  });

  it('lifts the glyph off the box centre so it reads on the text’s line', () => {
    // REPORTED as "it should be on the same line, now icon a bit more down".
    // `items-center` centres BOXES, and a line box reserves descender space its
    // ink mostly does not use — so the command's visible band sits above the
    // box centre while a square glyph lands exactly on it. Measured in the
    // running app at 3.5 device px of divergence, closed to 1.5.
    //
    // The CLASS is the observable and not a proxy: jsdom computes no layout, so
    // there is no rendered position to assert, and this class is the whole of
    // the correction — delete it and the glyph drops back.
    const el = render([shell()]);
    const glyph = el.querySelector('[data-slot="shell-row"] svg')!;
    expect(glyph.getAttribute('class')).toContain('-translate-y-px');
  });

  it('withholds the clock rather than reading an unparseable stamp as zero', () => {
    // A timestamp that will not parse is not a duration of nothing, which is
    // what `NaN` renders as once it reaches `formatElapsed`'s `Math.max(0, …)`.
    const el = render([shell({ startedAt: 'not-a-date' })]);
    expect(el.textContent).toContain('sleep 400');
    expect(el.textContent).not.toMatch(/\d+s/);
  });
});
