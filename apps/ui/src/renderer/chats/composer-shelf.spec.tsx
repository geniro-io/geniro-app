// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PullRequestRefResult } from '../../shared/contracts';
import type { AgentThread } from './agent-activity';
import {
  ComposerShelf,
  RunningShellChips,
  RunningSubagentChips,
  TaskListChip,
  ThreadPullRequestChips,
} from './composer-shelf';
import type { ShellRun } from './shell-activity';
import type { AgentTaskRow } from './task-payload';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;

const shell = (over: Partial<ShellRun> = {}): ShellRun =>
  ({
    id: 'c1',
    command: 'pnpm build',
    description: null,
    background: false,
    handle: null,
    status: 'running',
    exitCode: null,
    startedAt: new Date(Date.now() - 5_000).toISOString(),
    agentId: null,
    ...over,
  }) as ShellRun;

function render(shells: ShellRun[]): {
  el: HTMLElement;
  opened: ShellRun[];
} {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const opened: ShellRun[] = [];
  act(() => {
    root.render(
      <RunningShellChips shells={shells} onOpen={(s) => opened.push(s)} />,
    );
  });
  return { el: container, opened };
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('RunningShellChips', () => {
  it('draws nothing while no command is running', () => {
    // Unlike the header counter this replaced, which was deliberately drawn at
    // zero. A shelf is a row of what EXISTS — every chip on it comes and goes,
    // so an empty one is not mistaken for a missing readout.
    const { el } = render([]);
    expect(el.querySelector('[data-slot="running-shells"]')).toBeNull();
  });

  it('counts the running commands and holds them behind the chip', async () => {
    const { el } = render([
      shell(),
      shell({ id: 'c2', command: 'pnpm dev', background: true, handle: 'b1' }),
    ]);

    const chip = el.querySelector('[data-slot="running-shells"]')!;
    expect(chip.textContent).toContain('2');
    // Closed, the commands are not in the DOM at all — the count is the whole
    // of what the shelf spends space on.
    expect(el.textContent).not.toContain('pnpm build');

    await act(async () => {
      chip
        .querySelector('button')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(el.textContent).toContain('pnpm build');
    expect(el.textContent).toContain('pnpm dev');
  });

  it('opens the panel UPWARD, over the transcript rather than the composer', async () => {
    // `Popover` does no collision detection, so the side is the caller's to get
    // right — and this trigger sits directly on top of the textarea the user is
    // about to type in. A viewport-anchored panel is placed by ONE of two
    // inline offsets: `bottom` pins it above the trigger, `top` below it. That
    // is the observable, and it flips the moment `side` changes — jsdom
    // computes no layout, so the offsets themselves say nothing beyond which
    // branch ran.
    const { el } = render([shell()]);
    await act(async () => {
      el.querySelector<HTMLElement>(
        '[data-slot="running-shells"] button',
      )!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const panel = document.querySelector<HTMLElement>('[aria-label="Shells"]');
    expect(panel).not.toBeNull();
    expect(panel!.style.bottom).not.toBe('');
    expect(panel!.style.top).toBe('');
  });

  it('hands the whole command back when a row is opened', async () => {
    const { el, opened } = render([shell({ id: 'c9' })]);
    await act(async () => {
      el.querySelector('[data-slot="running-shells"] button')!.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });

    const row = [...document.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('pnpm build'),
    )!;
    await act(async () => {
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(opened.map((s) => s.id)).toEqual(['c9']);
  });
});

/**
 * Mount one chip on its own, the way {@link render} mounts the shell one.
 *
 * A second helper rather than a parameter on the first: the shell chip's
 * harness returns the commands its rows hand back, which the other two have no
 * analogue for.
 */
function mount(element: React.ReactElement): HTMLElement {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root.render(element);
  });
  return container;
}

/** Open a chip's panel the way a press does — hover-then-pin's pin half. */
async function press(el: HTMLElement, slot: string): Promise<void> {
  await act(async () => {
    el.querySelector(`[data-slot="${slot}"] button`)!.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
  });
}

const thread = (over: Partial<AgentThread> = {}): AgentThread => ({
  id: 't1',
  kind: 'subagent',
  label: 'explore the adapters',
  status: 'running',
  sessionId: null,
  ...over,
});

describe('RunningSubagentChips', () => {
  it('draws nothing while no delegate is working', () => {
    // The header counter this replaced was deliberately drawn at ZERO, on the
    // reported "здесь должна быть всегда иконка саб-эйджентов, даже если их
    // ноль" — a counter that appears only once something runs answers "are any
    // working" with the same blank space as a header that never had one. A
    // SHELF makes that distinction for itself: it is a row of what exists, and
    // the zero state is the row being one chip shorter.
    const el = mount(<RunningSubagentChips running={0} threads={[]} />);
    expect(el.querySelector('[data-slot="running-subagents"]')).toBeNull();
  });

  it('counts the WORKING delegates and holds every one of them behind the chip', async () => {
    const el = mount(
      <RunningSubagentChips
        running={1}
        threads={[
          thread(),
          thread({ id: 't2', label: 'review the diff', status: 'completed' }),
        ]}
      />,
    );

    const chip = el.querySelector('[data-slot="running-subagents"]')!;
    // ONE, not two: the figure is the live half, or it would climb all turn
    // and never come down.
    expect(chip.textContent).toContain('Sub-agents');
    expect(chip.textContent).toContain('1');
    // A SPINNER on the trigger, asked for by name. Honest because the chip is
    // not drawn at all below `running > 0` — so whenever it is on screen, a
    // delegate is working. Asserted on the TRIGGER rather than the chip's
    // subtree, since the panel's own rows spin for their own reasons.
    expect(
      chip
        .querySelector('[data-menu-trigger], button')
        ?.querySelector('svg.animate-spin'),
    ).not.toBeNull();
    // Closed, the delegates are not in the DOM at all.
    expect(el.textContent).not.toContain('review the diff');

    await press(el, 'running-subagents');

    // And the list is ALL of them — a chip reading `1` over a box holding one
    // row says nothing the reader could not already see.
    expect(el.textContent).toContain('explore the adapters');
    expect(el.textContent).toContain('review the diff');
    expect(el.textContent).toContain('completed');
  });

  it('opens the panel UPWARD, over the transcript rather than the composer', async () => {
    // Same reasoning, and same observable, as the shell chip above: `Popover`
    // does no collision detection, and a viewport-anchored panel is placed by
    // ONE of two inline offsets — `bottom` pins it above the trigger.
    const el = mount(<RunningSubagentChips running={1} threads={[thread()]} />);
    await press(el, 'running-subagents');

    const panel = document.querySelector<HTMLElement>(
      '[aria-label="Sub-agents"]',
    );
    expect(panel).not.toBeNull();
    expect(panel!.style.bottom).not.toBe('');
    expect(panel!.style.top).toBe('');
  });

  it('hands the delegate id back when a row is opened', async () => {
    const opened: string[] = [];
    const el = mount(
      <RunningSubagentChips
        running={1}
        threads={[thread({ id: 'call_9' })]}
        onOpen={(id) => opened.push(id)}
      />,
    );
    await press(el, 'running-subagents');

    const row = [...document.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('explore the adapters'),
    )!;
    await act(async () => {
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(opened).toEqual(['call_9']);
  });
});

describe('TaskListChip', () => {
  const task = (over: Partial<AgentTaskRow> = {}): AgentTaskRow => ({
    id: '1',
    title: 'read the spec',
    status: 'completed',
    activeForm: null,
    ...over,
  });

  it('draws nothing when no agent here keeps a list', () => {
    const el = mount(
      <TaskListChip done={0} total={0} tasks={[]} live={true} />,
    );
    expect(el.querySelector('[data-slot="open-tasks"]')).toBeNull();
  });

  it('states the DENOMINATOR, never a bare remaining count', async () => {
    // REPORTED as "here we need to show all amount of tasks as well": a lone
    // `3` leaves the reader unable to tell three-of-four from three-of-forty,
    // and it can only shrink — so it reads as a countdown out of a number
    // nothing states.
    const el = mount(
      <TaskListChip done={3} total={8} tasks={[task()]} live={true} />,
    );
    const chip = el.querySelector('[data-slot="open-tasks"]')!;
    expect(chip.textContent).toContain('Tasks');
    expect(chip.textContent).toContain('3/8');
  });

  it('holds the list itself behind the pair', async () => {
    const el = mount(
      <TaskListChip
        done={1}
        total={2}
        tasks={[
          task(),
          task({
            id: '2',
            title: 'write the adapter',
            status: 'in_progress',
            activeForm: 'writing the adapter',
          }),
        ]}
        live={true}
      />,
    );
    expect(el.textContent).not.toContain('read the spec');

    await press(el, 'open-tasks');

    expect(el.textContent).toContain('read the spec');
    // The running row reads in its present-continuous form, as it does
    // everywhere else the same list is drawn.
    expect(el.textContent).toContain('writing the adapter');
  });

  it('stops the running row spinning once nothing is advancing the list', async () => {
    // A thread that settled mid-task leaves an `in_progress` row behind it, and
    // a spinner there claims work that stopped — the same rule the transcript
    // cards and the agents panel already follow.
    const el = mount(
      <TaskListChip
        done={0}
        total={1}
        tasks={[
          task({
            id: '2',
            title: 'write the adapter',
            status: 'in_progress',
            activeForm: 'writing the adapter',
          }),
        ]}
        live={false}
      />,
    );
    await press(el, 'open-tasks');

    const panel = document.querySelector('[aria-label="Task list"]')!;
    expect(panel.querySelector('svg.animate-spin')).toBeNull();
    // And the present-continuous label goes with it: "writing the adapter"
    // about a list nobody is advancing states an edit that is not under way.
    expect(panel.textContent).toContain('write the adapter');
    expect(panel.textContent).not.toContain('writing the adapter');
  });
});

describe('every shelf chip', () => {
  it('sizes its label on the BUTTON, where an inherited size cannot reach', () => {
    // `global.css`'s base rule sets `button { font-size: var(--text-base) }`,
    // which DEFEATS an inherited size — so a chip whose type size lives on the
    // shelf row rather than on its own trigger renders 15px medium beside 12px
    // neighbours. That was REPORTED once already, of these very counters in the
    // header ("давай сделаем меньше вот эти циферки"), and the fix travelled
    // with them: `SHELF_CHIP_CLASS` carries `text-xs` and `HoverPopover` puts
    // it on the button itself.
    //
    // Classes, not `getComputedStyle` — jsdom loads no stylesheet, so every
    // computed size here is the default and the assertion would pass with the
    // fix deleted.
    const el = mount(
      <>
        <TaskListChip done={1} total={2} tasks={[]} live={true} />
        <RunningSubagentChips running={1} threads={[thread()]} />
      </>,
    );
    const triggers = [...el.querySelectorAll<HTMLElement>('button')];
    expect(triggers).toHaveLength(2);
    for (const trigger of triggers) {
      expect(trigger.className).toContain('text-xs');
    }
  });
});

const pr = (number: number): PullRequestRefResult => ({
  ref: {
    owner: 'geniro-io',
    repo: 'geniro-app',
    number,
    url: `https://github.com/geniro-io/geniro-app/pull/${number}`,
  },
  pullRequest: {
    number,
    title: `pull request ${number}`,
    url: `https://github.com/geniro-io/geniro-app/pull/${number}`,
    state: 'open',
    isDraft: false,
    headRefName: `b${number}`,
    headRepositoryOwner: 'geniro-io',
    isCrossRepository: false,
    author: 'sergey',
    updatedAt: new Date().toISOString(),
  },
});

describe('the shelf — separate chips, ONE joined group', () => {
  it('keeps the chips SEPARATE — each its own card, with gaps', () => {
    // The whole row was joined into one segmented bar for a moment and that was
    // rejected on sight: "but chips still should be separate, as before. What i
    // told - ts only for prs". Touching is a claim that two things are one, and
    // it is false of a terminal and a task list.
    //
    // Asserted on the emitted classes, because Tailwind is a build step and
    // jsdom loads no stylesheet: `getComputedStyle` reports the default for
    // every element here and would pass with the change reverted. The class IS
    // the mechanism.
    const el = mount(
      <ComposerShelf>
        <TaskListChip done={1} total={2} tasks={[]} live={true} />
        <RunningSubagentChips running={1} threads={[thread()]} />
      </ComposerShelf>,
    );
    const shelf = el.querySelector('[data-slot="composer-shelf"]')!;
    expect(shelf.className).toContain('gap-1.5');
    // The row itself wears NO card — that belongs to each chip.
    expect(shelf.className).not.toContain('divide-x');
    expect(shelf.className).not.toContain('shadow-panel-sm');
    for (const chip of el.querySelectorAll<HTMLElement>('button')) {
      expect(chip.className).toContain('rounded-lg');
      expect(chip.className).toContain('shadow-panel-sm');
      // And the card's radius still beats HoverPopover's own `rounded-full`,
      // or a counter would fill as a lozenge inside its own chip.
      expect(chip.className).not.toContain('rounded-full');
    }
  });

  it('joins the pull requests and their `All N` under ONE card', () => {
    // The one place touching is true. `All 4` standing apart as a fifth
    // identical pill read as a peer of `Tasks 2/6`, because nothing on the row
    // said which items belonged together.
    const el = mount(
      <ComposerShelf>
        <ThreadPullRequestChips results={[pr(1), pr(2), pr(3), pr(4)]} />
      </ComposerShelf>,
    );
    const group = el.querySelector<HTMLElement>(
      '[data-slot="pull-request-group"]',
    )!;
    expect(group.className).toContain('divide-x');
    expect(group.className).toContain('rounded-lg');
    expect(group.className).toContain('shadow-panel-sm');
    expect(group.className).toContain('overflow-hidden');
    // The `All N` is INSIDE it, and last — which is what makes the glyph read
    // as "and all four of them" rather than as a fourth pull request.
    const all = group.querySelector<HTMLElement>(
      '[data-slot="all-pull-requests"]',
    )!;
    expect(all.textContent).toBe('All 4');
    expect([...group.children].at(-1)).toBe(all);
    // No segment redraws the card: one with its own hairline draws a second
    // line beside the divider, one with its own radius leaves notches of the
    // group's background inside the run.
    for (const segment of group.children) {
      expect(segment.className).not.toContain('rounded-lg');
      expect(segment.className).not.toContain('shadow-panel-sm');
      expect(segment.className).not.toMatch(/(^| )border( |$)/);
    }
  });

  it('gives the `All N` control the mark of the thing it counts', () => {
    // It was the one item on the shelf naming no subject, and the hardest to
    // guess, being a control rather than a reading — `All 4` beside `Tasks 2/6`
    // says nothing about which of them it belongs to.
    const el = mount(
      <ComposerShelf>
        <ThreadPullRequestChips results={[pr(1), pr(2), pr(3), pr(4)]} />
      </ComposerShelf>,
    );
    const all = el.querySelector<HTMLElement>(
      '[data-slot="all-pull-requests"]',
    )!;
    expect(all.querySelector('svg')).not.toBeNull();
  });

  it('draws a LONE pull request through the same group, so the two shapes cannot drift', () => {
    // A group of one is visually identical to a standalone chip — the card is
    // the same card — so there is no branch to keep in step.
    const el = mount(
      <ComposerShelf>
        <ThreadPullRequestChips results={[pr(1)]} />
      </ComposerShelf>,
    );
    const group = el.querySelector<HTMLElement>(
      '[data-slot="pull-request-group"]',
    )!;
    expect(group).not.toBeNull();
    expect(group.children).toHaveLength(1);
    expect(el.querySelector('[data-slot="all-pull-requests"]')).toBeNull();
  });
});

describe('the shelf under a squeeze', () => {
  it('puts shrink-0 on the WRAPPER, not only on the trigger inside it', () => {
    // REPORTED as "terminals chip have some problems with margin".
    // `HoverPopover` renders a wrapper span around its trigger, and the WRAPPER
    // is what the shelf lays out — the trigger is a flex child of it. With the
    // class on the trigger alone the wrapper collapsed under a crowded row
    // while the button inside refused to, so the button spilled out of its own
    // box and the next chip was placed against the collapsed one. Measured in
    // the running app at a 430px shelf: the sub-agents span ran 725–810 while
    // its own button ran 725–837, and the terminals span began at 816 — 21px
    // INSIDE its neighbour. The gap does not shrink; it vanishes and the chips
    // overlap.
    //
    // Classes, not geometry: jsdom computes no layout, so the overlap itself
    // is unobservable here and would pass with the fix deleted. The class is
    // the mechanism, and it is on an element the test can name.
    const el = mount(
      <ComposerShelf>
        <TaskListChip done={1} total={2} tasks={[]} live={true} />
        <RunningSubagentChips running={1} threads={[thread()]} />
        <RunningShellChips shells={[shell()]} onOpen={() => undefined} />
      </ComposerShelf>,
    );
    const wrappers = [
      ...el.querySelectorAll<HTMLElement>('[data-slot]'),
    ].filter(
      (node) =>
        node.dataset.slot === 'open-tasks' ||
        node.dataset.slot === 'running-subagents' ||
        node.dataset.slot === 'running-shells',
    );
    expect(wrappers).toHaveLength(3);
    for (const wrapper of wrappers) {
      expect(wrapper.className).toContain('shrink-0');
      // And the trigger keeps its own, which does the OTHER half of the job:
      // the wrapper must not squeeze the button either.
      expect(wrapper.querySelector('button')!.className).toContain('shrink-0');
    }
  });

  it('clips a segment’s own content rather than letting it print over its neighbour', () => {
    // A pull-request chip is [icon][number][title] with the NUMBER deliberately
    // `shrink-0` — it identifies the thing, so it must never truncate. Under a
    // hard squeeze that unshrinkable content spilled out of its segment and
    // over the `All 4` beside it: measured at a 430px shelf as two overlapping
    // strings. The GROUP's own clip cannot help, the two being siblings inside
    // it. A cut-off number reads as "there is more here"; overlapping glyphs
    // read as a broken app.
    const el = mount(
      <ComposerShelf>
        <ThreadPullRequestChips results={[pr(1), pr(2), pr(3), pr(4)]} />
      </ComposerShelf>,
    );
    const group = el.querySelector<HTMLElement>(
      '[data-slot="pull-request-group"]',
    )!;
    for (const segment of group.children) {
      expect(segment.className).toContain('overflow-hidden');
    }
  });
});
