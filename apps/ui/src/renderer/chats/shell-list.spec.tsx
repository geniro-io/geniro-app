// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { confirmInDialog } from '../__tests__/confirm-in-dialog';
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
    callId: null,
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
  it('gives the command its own line, with the tag and the note under it', () => {
    const el = render([
      shell({
        background: true,
        command: 'pnpm dev',
        description: 'Dev server',
      }),
    ]);
    const row = el.querySelector('[data-slot="shell-row"]')!;
    const [commandLine, detailLine] = [...row.children];

    // There is deliberately no caption over the rows — the band used to carry
    // `1 shell running`, which on the commonest case was a whole line counting
    // the single line beneath it.
    expect(commandLine?.querySelector('svg')).not.toBeNull();
    expect(commandLine?.textContent).toContain('pnpm dev');
    expect(commandLine?.textContent).toMatch(/\d+s/);
    // The tag and the agent's own note sit UNDER the command: beside it the tag
    // took the width a 280px panel had for the command (`pnpm d…`).
    expect(commandLine?.textContent).not.toContain('background');
    expect(detailLine?.getAttribute('data-slot')).toBe('shell-detail');
    expect(detailLine?.textContent).toContain('Dev server');
    expect(detailLine?.textContent).toContain('background');
  });

  it('keeps a foreground command with no note to ONE line', () => {
    const el = render([shell()]);
    expect(el.querySelector('[data-slot="shell-detail"]')).toBeNull();
  });

  it('names the agent that started each command when the list mixes several', () => {
    // The shelf flattens every agent's shells into ONE popover, so on a
    // team the rows it holds come from different agents with nothing on
    // them saying which — asked for as "we should have labels there then for
    // each terminal - from which agent is it (in case if we are in team)".
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

  it('asks in a dialog, naming the command, before stopping it', async () => {
    const onKill = vi.fn();
    const el = render([shell({ command: 'pnpm dev' })], undefined, onKill);

    act(() => killButton(el)!.click());

    expect(onKill).not.toHaveBeenCalled();
    expect(
      document.querySelector('[role="dialog"][aria-modal="true"]')?.textContent,
    ).toContain('pnpm dev');

    await act(async () => confirmInDialog('Stop').click());

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

  it('keeps the stop glyph round and tinted destructive on hover', () => {
    const el = render([shell({})], undefined, () => undefined);
    const button = killButton(el)!;
    expect(button.className).toContain('rounded-full');
    expect(button.className).toContain('hover:bg-destructive/10');
    expect(button.className).not.toContain('hover:bg-accent');
  });
});
