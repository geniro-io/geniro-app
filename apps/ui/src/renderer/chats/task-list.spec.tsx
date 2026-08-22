// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RunSettledContext } from './live-row';
import { TaskListCard, TaskRows, TaskScrollRows } from './task-list';
import type { AgentTaskRow } from './task-payload';
import type { TaskListEntry } from './transcript-groups';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
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

function render(el: React.ReactNode): void {
  act(() => root.render(el));
}

const rows: AgentTaskRow[] = [
  { id: '1', title: 'Read the file', status: 'completed', activeForm: null },
  {
    id: '2',
    title: 'Edit the file',
    status: 'in_progress',
    activeForm: 'Editing the file',
  },
  { id: '3', title: 'Run the tests', status: 'pending', activeForm: null },
];

function card(overrides: Partial<TaskListEntry> = {}): TaskListEntry {
  return {
    type: 'task-list',
    id: 'c1',
    createdAt: '2026-08-14T10:00:00.000Z',
    seq: 5,
    nodeId: null,
    parentToolUseId: null,
    tasks: rows,
    latest: true,
    ...overrides,
  };
}

/** Every task line on screen, in order. */
function taskTexts(): string[] {
  return [...container.querySelectorAll('li')].map(
    (row) => row.textContent ?? '',
  );
}

/**
 * Whether anything on screen is actually SPINNING.
 *
 * The animation class, which is what makes the glyph move — not a marker the
 * test invented, and not "is the icon a Loader2", which would pass on a static
 * copy of it.
 */
function spinning(): boolean {
  return container.querySelector('.animate-spin') !== null;
}

/** The card's own expand/collapse control. */
function disclosure(): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>(
    '[data-slot="task-list-card"] button',
  )!;
}

describe('TaskListCard', () => {
  it('draws its heading INSIDE the section caption, which is what sizes it', () => {
    // The reported "task list title should be smaller", pinned where jsdom can
    // see it. The size itself is a cascade — `SectionLabel` scopes a rule to
    // the buttons under it (block-shell.spec pins that rule) — so the fact this
    // card has to hold up is that its heading is UNDER that caption. Lift the
    // button out of `SectionLabel`, as an ordinary refactor easily might, and
    // the base `button` rule takes it back to 15px with nothing else changing.
    render(<TaskListCard entry={card()} />);
    const caption = container.querySelector('[data-slot="task-list-card"] p')!;

    expect(caption.contains(disclosure())).toBe(true);
  });

  it('lists every task and says how far along the list is', () => {
    render(<TaskListCard entry={card()} />);
    expect(taskTexts()).toEqual([
      'Read the file',
      // The present-continuous label for the one being worked on — what the
      // CLI's own UI shows there, and the reason the daemon carries the field.
      'Editing the file',
      'Run the tests',
    ]);
    expect(container.textContent).toContain('1/3');
  });

  it('names a task by its id when no announcement carried its text', () => {
    // Reachable: a claude `TaskUpdate` patch can be the FIRST thing seen for a
    // task, and it sends `{taskId, status}` alone. An empty row would be worse.
    render(
      <TaskListCard
        entry={card({
          tasks: [
            { id: '9', title: null, status: 'pending', activeForm: null },
          ],
        })}
      />,
    );
    expect(taskTexts()).toEqual(['Task 9']);
  });

  it('renders nothing at all for an empty list', () => {
    render(<TaskListCard entry={card({ tasks: [] })} />);
    expect(container.firstChild).toBeNull();
  });
});

describe('one list, not one copy of it per step', () => {
  it('collapses a card the list has already moved past', () => {
    // "Todo is duplicating. Why?" — an agent that says one sentence between two
    // announcements got a card on each side of it, and both printed the whole
    // eight-row list. There is ONE list; the earlier card is where it stood,
    // not a second copy of it.
    render(<TaskListCard entry={card({ latest: false })} />);
    expect(taskTexts()).toEqual([]);
    // It still says what the list was doing at that point — the whole reason
    // the row stays in the flow rather than being dropped.
    expect(container.textContent).toContain('1/3');
    expect(
      container.querySelector('[data-slot="task-list-current"]')?.textContent,
    ).toContain('Editing the file');
    expect(disclosure().getAttribute('aria-expanded')).toBe('false');
  });

  it('opens on a click and closes again', () => {
    render(<TaskListCard entry={card({ latest: false })} />);
    act(() => disclosure().click());
    expect(taskTexts()).toHaveLength(3);
    act(() => disclosure().click());
    expect(taskTexts()).toEqual([]);
  });

  it('folds a card away by ITSELF the moment a newer one lands', () => {
    // The state is derived from `latest` rather than seeded into `useState`: a
    // seeded initial value only applies at mount, so the card that was current
    // when it appeared would stay expanded for good — and the duplication comes
    // straight back on the next announcement.
    render(<TaskListCard entry={card()} />);
    expect(taskTexts()).toHaveLength(3);
    render(<TaskListCard entry={card({ latest: false })} />);
    expect(taskTexts()).toEqual([]);
  });

  it('keeps a card the reader opened open when it is superseded', () => {
    // Their choice outranks the default, or reading an old list is a race
    // against the agent's next announcement.
    render(<TaskListCard entry={card({ latest: false })} />);
    act(() => disclosure().click());
    render(<TaskListCard entry={card({ latest: false, seq: 6 })} />);
    expect(taskTexts()).toHaveLength(3);
  });
});

describe('a task list nothing is working through', () => {
  it('stops the in-progress row spinning once the run has settled', () => {
    // The reported defect: "somewhere it finished one task, still in progress
    // for some reason" — a chat whose turn ended with a task mid-flight kept a
    // spinner on it for good. The row is still distinguishable from pending; it
    // just stops claiming that work is happening.
    render(
      <RunSettledContext.Provider value={Date.parse('2026-08-14T11:00:00Z')}>
        <TaskListCard entry={card()} />
      </RunSettledContext.Provider>,
    );
    expect(spinning()).toBe(false);
    // And it says "Edit the file", not "Editing the file": the active form is a
    // claim about work under way.
    expect(taskTexts()).toContain('Edit the file');
    // Stated on the element too, because the verdict is not otherwise visible
    // from outside: the rule reads a context value and the card's own place in
    // its thread, so this is the only handle a test or an inspector has on it.
    expect(
      container
        .querySelector('[data-slot="task-list-card"]')
        ?.getAttribute('data-live'),
    ).toBe('false');
  });

  it('keeps spinning while the run is live', () => {
    render(
      <RunSettledContext.Provider value={null}>
        <TaskListCard entry={card()} />
      </RunSettledContext.Provider>,
    );
    expect(spinning()).toBe(true);
  });

  it('stops an EARLIER card spinning even on a live run', () => {
    // A historical snapshot: the list has moved on since. Three cards each
    // animating their own in-progress task is three spinners for one task, none
    // of them still true.
    render(
      <RunSettledContext.Provider value={null}>
        <TaskListCard entry={card({ latest: false })} />
      </RunSettledContext.Provider>,
    );
    // Opened by hand, because a superseded card is collapsed — without this the
    // assertion would hold for the trivial reason that no row is on screen.
    act(() => disclosure().click());
    expect(taskTexts()).toHaveLength(3);
    expect(spinning()).toBe(false);
  });

  it('keeps spinning for a card written AFTER the run settled', () => {
    // The off-turn case: the CLI carries on by itself past its own turn-end
    // line, so a card newer than the settle is live work whatever the row says.
    render(
      <RunSettledContext.Provider value={Date.parse('2026-08-14T09:00:00Z')}>
        <TaskListCard entry={card()} />
      </RunSettledContext.Provider>,
    );
    expect(spinning()).toBe(true);
  });
});

describe('TaskRows', () => {
  it('renders a live list with motion and a dead one without', () => {
    // The shared renderer both surfaces use, so the side panel and the
    // transcript cannot disagree about what a running task looks like.
    render(<TaskRows tasks={rows} live />);
    expect(spinning()).toBe(true);
    render(<TaskRows tasks={rows} live={false} />);
    expect(spinning()).toBe(false);
  });
});

describe('TaskScrollRows — the panel’s bounded copy', () => {
  const box = (): HTMLElement =>
    container.querySelector<HTMLElement>('[data-slot="task-scroll-rows"]')!;

  /**
   * Lay the box out: jsdom computes nothing, so the numbers the reveal reads
   * are supplied here — a 100px frame over 30px rows.
   *
   * Defined on the PROTOTYPES rather than on the nodes, because React replaces
   * neither across a re-render but the rows this returns would be captured
   * before one; `clientHeight` is the box's own and every `li` reports its
   * index * 30.
   */
  function layOut(): () => void {
    const proto = HTMLElement.prototype;
    const original = {
      clientHeight: Object.getOwnPropertyDescriptor(proto, 'clientHeight'),
      offsetTop: Object.getOwnPropertyDescriptor(proto, 'offsetTop'),
      offsetHeight: Object.getOwnPropertyDescriptor(proto, 'offsetHeight'),
    };
    const indexOf = (el: HTMLElement): number =>
      [...(el.parentElement?.children ?? [])].indexOf(el);
    Object.defineProperty(proto, 'clientHeight', {
      configurable: true,
      get(this: HTMLElement) {
        return this.dataset.slot === 'task-scroll-rows' ? 100 : 0;
      },
    });
    Object.defineProperty(proto, 'offsetTop', {
      configurable: true,
      get(this: HTMLElement) {
        return this.tagName === 'LI' ? indexOf(this) * 30 : 0;
      },
    });
    Object.defineProperty(proto, 'offsetHeight', {
      configurable: true,
      get(this: HTMLElement) {
        return this.tagName === 'LI' ? 30 : 0;
      },
    });
    return () => {
      for (const [name, desc] of Object.entries(original)) {
        if (desc) {
          Object.defineProperty(proto, name, desc);
        } else {
          delete (proto as unknown as Record<string, unknown>)[name];
        }
      }
    };
  }

  /** A list of `count` tasks with the one at `activeIndex` in progress. */
  function longList(count: number, activeIndex: number): AgentTaskRow[] {
    return Array.from({ length: count }, (_, i) => ({
      id: `t${i}`,
      title: `Task ${i}`,
      status:
        i < activeIndex
          ? ('completed' as const)
          : i === activeIndex
            ? ('in_progress' as const)
            : ('pending' as const),
      activeForm: null,
    }));
  }

  it('bounds its own height and scrolls itself', () => {
    // The panel has ONE scroller over every agent card, so a long list does not
    // overflow anything — it makes its own card that tall and pushes the next
    // agent off the screen. jsdom computes no layout, so the pin is the pair of
    // properties that decide it.
    render(<TaskScrollRows tasks={rows} live />);
    const classes = box().getAttribute('class') ?? '';
    expect(classes).toContain('max-h-48');
    expect(classes).toContain('overflow-y-auto');
  });

  it('leaves the TRANSCRIPT card unbounded', () => {
    // A nested scroll box inside a document the reader scrolls takes the wheel
    // away from the page whenever the pointer is over the list.
    render(<TaskListCard entry={card()} />);
    expect(
      container.querySelector('[data-slot="task-scroll-rows"]'),
    ).toBeNull();
  });

  it('follows the running task down as the agent moves on', () => {
    const restore = layOut();
    try {
      render(<TaskScrollRows tasks={longList(12, 1)} live />);
      // Row 1 sits at 30 in a 100px frame — already visible, so nothing moved.
      expect(box().scrollTop).toBe(0);

      render(<TaskScrollRows tasks={longList(12, 8)} live />);
      // Row 8 spans 240–270; the frame has to end at 270.
      expect(box().scrollTop).toBe(170);
    } finally {
      restore();
    }
  });

  it('does not move a list nothing is working through', () => {
    // The `in_progress` row of a settled list is a task that STOPPED there.
    // Chasing it would scroll a reader's box on a card that is pure history.
    const restore = layOut();
    try {
      render(<TaskScrollRows tasks={longList(12, 8)} live={false} />);
      expect(box().scrollTop).toBe(0);
    } finally {
      restore();
    }
  });
});
