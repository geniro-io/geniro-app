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

function render(
  shells: ShellRun[],
  agentNameOf?: ReadonlyMap<string, string>,
  onKill?: (shell: ShellRun) => void,
): HTMLElement {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <ShellRows shells={shells} agentNameOf={agentNameOf} onKill={onKill} />,
    );
  });
  return container;
}

const killButton = (el: HTMLElement): HTMLButtonElement | null =>
  el.querySelector<HTMLButtonElement>('[data-slot="shell-kill"]');

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

  it('names the agent that started each command when the list mixes several', () => {
    // The shelf flattens every agent's shells into ONE popover, so on a
    // workflow the rows it holds come from different agents with nothing on
    // them saying which — asked for as "we should have labels there then for
    // each terminal - from which agent is it (in case if we are in workflow)".
    const el = render(
      [shell({ id: 'c1' }), shell({ id: 'c2', command: 'pnpm dev' })],
      new Map([
        ['c1', 'Engineer'],
        ['c2', 'Manager'],
      ]),
    );
    const rows = [...el.querySelectorAll('[data-slot="shell-row"]')];
    expect(
      rows.map(
        (r) => r.querySelector('[data-slot="shell-agent"]')?.textContent,
      ),
    ).toEqual(['Engineer', 'Manager']);
  });

  it('draws NO agent label for a list that is already about one agent', () => {
    // The agents panel's band sits inside one agent's card and a 1:1 chat has
    // one agent, so the name would be the same word down every row — and this
    // popover is 22rem, where a redundant column costs the command its width.
    const el = render([shell()]);
    expect(el.querySelector('[data-slot="shell-agent"]')).toBeNull();
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

  it('offers NO stop control to a caller that handed it none', () => {
    // The rule every list on this surface follows: it never invents a surface
    // it was not given. A button that looked like it stopped a command and did
    // nothing is worse here than in most places, because the reader would go
    // looking for the process by hand having been told it was dealt with.
    expect(killButton(render([shell()]))).toBeNull();
  });

  it('takes TWO presses to stop a command', () => {
    // Killing a `pnpm dev` is destructive and there is no undo, and these rows
    // are hover-height inside a popover — exactly where a stray click lands. So
    // it goes through the app's one `ConfirmButton`: the first press ARMS (the
    // control paints itself destructive) and only the second fires.
    const onKill = vi.fn();
    const el = render([shell()], undefined, onKill);
    const button = killButton(el)!;
    const resting = button.className;

    act(() => button.click());

    expect(onKill).not.toHaveBeenCalled();
    // The arming has to be VISIBLE, or the second press is a surprise. jsdom
    // computes no CSS, so the emitted class IS the mechanism here.
    expect(button.className).not.toBe(resting);

    act(() => button.click());

    expect(onKill).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }));
  });

  it('names the command it stops, since the row above it truncates', () => {
    // The command is the flex column and is routinely a pipeline, so the row's
    // own text is not a reliable answer to "which one am I about to stop" —
    // which is the question worth answering on the press that cannot be undone.
    const el = render(
      [shell({ command: 'pnpm dev --filter @geniro/ui' })],
      undefined,
      vi.fn(),
    );

    expect(killButton(el)!.getAttribute('title')).toContain(
      'pnpm dev --filter @geniro/ui',
    );
  });
});
