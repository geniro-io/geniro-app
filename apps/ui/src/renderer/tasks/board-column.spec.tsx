// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BoardColumn } from './board-column';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

function column(
  autopilot?: React.ComponentProps<typeof BoardColumn>['autopilot'],
  onOpenTask: (taskId: string) => void = vi.fn(),
): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <BoardColumn
        status="todo"
        tasks={[]}
        selectedTaskId={null}
        draggingTaskId={null}
        isDropTarget={false}
        onOpenTask={onOpenTask}
        onDragStartTask={vi.fn()}
        onDragEndTask={vi.fn()}
        onDragOver={vi.fn()}
        onDragLeave={vi.fn()}
        onDrop={vi.fn()}
        onAddTask={vi.fn()}
        autopilot={autopilot}
      />,
    );
  });
  return container;
}

const byLabel = (el: HTMLElement, label: string): HTMLElement | null =>
  el.querySelector(`[aria-label="${label}"]`);

const armed = {
  breakerOpen: false,
  waiting: null,
  blocked: [],
  onStop: vi.fn(),
};

/** Cards the daemon will not hand out, with its own reason for each. */
const stuck = (
  count: number,
  reason = 'no agent or workflow — set one on this task, or a default for the project',
): { id: string; title: string; reason: string }[] =>
  Array.from({ length: count }, (_unused, index) => ({
    id: `t${index}`,
    title: `Card ${index}`,
    reason,
  }));

describe('BoardColumn — the autopilot banner', () => {
  it('draws no banner on a column the autopilot does not read', () => {
    const el = column();

    expect(el.querySelector('[data-slot="autopilot-banner"]')).toBeNull();
    expect(byLabel(el, 'Stop the autopilot')).toBeNull();
  });

  it('says work is picked up here, and offers Stop', () => {
    const el = column(armed);

    expect(el.textContent).toContain('Autopilot starts tasks here');
    expect(byLabel(el, 'Stop the autopilot')).not.toBeNull();
  });

  // The count comes from the DAEMON's queue, not from the column: a card's
  // column is written optimistically on a drag.
  it('counts what is waiting once the queue has been read', () => {
    expect(column({ ...armed, waiting: 3 }).textContent).toContain('3 waiting');
    expect(column({ ...armed, waiting: 0 }).textContent).toContain(
      'Autopilot starts tasks here',
    );
  });

  // REPORTED against a board reading `2 running` under a `To do 0` header,
  // with both cards sitting in `In progress`: a started card LEAVES this
  // column, so the one column that can never hold a running card was the one
  // counting them. What is running is a fact about the board and is said on
  // the header instead.
  it('never counts what is RUNNING — those cards have left this column', () => {
    const el = column({ ...armed, waiting: 1 });

    expect(el.textContent).toContain('1 waiting');
    expect(el.textContent).not.toContain('running');
  });

  // REPORTED as "я прямо сейчас вижу, что он waiting, но он ничего не делает":
  // a card the daemon refuses is still sitting in the intake column, so it was
  // counted in `waiting` and the band read `2 waiting` beside a Stop button,
  // forever, with nothing on it saying why.
  describe('a board where nothing can start', () => {
    it('says so, instead of counting the cards as waiting', () => {
      const el = column({
        ...armed,
        waiting: 2,
        blocked: stuck(2),
      });

      expect(el.textContent).toContain('2 tasks cannot start');
      expect(el.textContent).not.toContain('waiting');
    });

    it('SUBTRACTS the blocked cards from the waiting count', () => {
      // `3 waiting · 2 cannot start` reads as five cards. A count that
      // includes what it then contradicts is the same defect one step quieter.
      const el = column({
        ...armed,
        waiting: 3,
        blocked: stuck(2),
      });

      expect(el.textContent).toContain('1 waiting · 2 tasks cannot start');
    });

    it('spells the singular rather than deriving it', () => {
      const el = column({
        ...armed,
        waiting: 1,
        blocked: stuck(1),
      });

      expect(el.textContent).toContain('1 task cannot start');
      expect(el.textContent).not.toContain('1 tasks');
    });

    // REPORTED as "я должен, видимо, иметь возможность кликнуть и увидеть
    // точную причину, почему они не могут стартовать, и что мне нужно
    // сделать". The line used to carry the daemon's sentence on a `title`
    // alone — invisible until hovered, naming one card of several, and
    // offering no way to act on any of it.
    describe('the explanation behind the line', () => {
      const line = (el: HTMLElement): HTMLElement | null =>
        el.querySelector(
          '[data-slot="autopilot-banner"] button[aria-expanded]',
        );

      const panel = (): HTMLElement | null =>
        document.querySelector('[aria-label="Why these tasks cannot start"]');

      it('is not on screen until the line is pressed', () => {
        const el = column({ ...armed, waiting: 2, blocked: stuck(2) });

        expect(line(el)).not.toBeNull();
        expect(panel()).toBeNull();
      });

      it('names every blocked card and the daemon’s own reason for it', () => {
        const el = column({ ...armed, waiting: 2, blocked: stuck(2) });

        act(() => {
          line(el)?.click();
        });

        const text = panel()?.textContent ?? '';
        expect(text).toContain('Card 0');
        expect(text).toContain('Card 1');
        // The daemon's sentence verbatim — restating it here would be a second
        // wording of one refusal, free to drift from the enforced one.
        expect(text).toContain(
          'no agent or workflow — set one on this task, or a default for the project',
        );
      });

      it('opens a card from its row, which is where its own agent is set', () => {
        const onOpenTask = vi.fn();
        const el = column(
          { ...armed, waiting: 1, blocked: stuck(1) },
          onOpenTask,
        );

        act(() => {
          line(el)?.click();
        });
        act(() => {
          panel()
            ?.querySelector('li button')
            ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });

        expect(onOpenTask).toHaveBeenCalledWith('t0');
        // And it gets out of the way, having answered the question it was
        // opened for — the card's own panel is what the user is now looking at.
        expect(panel()).toBeNull();
      });

      it('offers the board’s settings — the OTHER place the answer goes', () => {
        const onFixBlocked = vi.fn();
        const el = column({
          ...armed,
          waiting: 1,
          blocked: stuck(1),
          onFixBlocked,
        });

        act(() => {
          line(el)?.click();
        });
        // By its own words, not by "a button mentioning an agent" — every
        // ROW says `no agent or workflow`, so the loose match pressed a card.
        const fix = [...(panel()?.querySelectorAll('button') ?? [])].find(
          (button) => button.textContent?.startsWith('Set the board'),
        );
        act(() => {
          fix?.click();
        });

        expect(onFixBlocked).toHaveBeenCalledTimes(1);
      });

      it('offers no fix it was given no way to make', () => {
        // A button that does nothing is worse than the sentence alone: the
        // rows still say what to change and still open the cards.
        const el = column({ ...armed, waiting: 1, blocked: stuck(1) });

        act(() => {
          line(el)?.click();
        });

        expect(panel()?.textContent).not.toContain('Set the board');
      });
    });

    it('wears the warning tone, since it is a state to act on', () => {
      const calm = column({ ...armed, waiting: 1 });
      const el = column({
        ...armed,
        waiting: 1,
        blocked: stuck(1),
      });

      expect(
        calm.querySelector('[data-slot="autopilot-banner"]')?.className,
      ).toContain('text-muted-foreground');
      expect(
        el.querySelector('[data-slot="autopilot-banner"]')?.className,
      ).toContain('text-warning');
    });

    it('still offers Stop — the autopilot is armed, it just cannot start', () => {
      const el = column({
        ...armed,
        waiting: 1,
        blocked: stuck(1),
      });

      expect(byLabel(el, 'Stop the autopilot')).not.toBeNull();
    });

    it('leaves a STOPPED autopilot its own sentence, which outranks this', () => {
      const el = column({
        ...armed,
        breakerOpen: true,
        waiting: 1,
        blocked: stuck(1),
      });

      expect(el.textContent).toContain('Autopilot is stopped');
      expect(el.textContent).not.toContain('cannot start');
    });
  });

  // A zero it cannot stand behind is worse than no number: an unread queue
  // falls back to the plain sentence rather than claiming nothing is queued.
  it('states no counts at all while the queue is unread', () => {
    const el = column({ ...armed, waiting: null });

    expect(el.textContent).toContain('Autopilot starts tasks here');
    expect(el.textContent).not.toMatch(/\d+ (running|waiting)/);
  });

  it('says nothing in an empty column at rest, and hints only on a drag', () => {
    expect(column().textContent).not.toContain('No tasks');
    expect(column().textContent).not.toContain('Drop here');
  });

  // Always visible and never behind a confirm: it is what a user reaches for
  // when something is going wrong, and a dialog in the way is the wrong thing
  // to meet at that moment.
  it('disarms straight from the press, with nothing in between', () => {
    const onStop = vi.fn();
    const el = column({ ...armed, onStop });

    act(() => {
      byLabel(el, 'Stop the autopilot')?.click();
    });

    expect(onStop).toHaveBeenCalledTimes(1);
    // No confirm dialog anywhere on the way.
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  // A stopped autopilot is not stoppable, and the WHY is not stated here: the
  // explanation and the way to restart it live on the header control, where
  // the rest of the setting is. A column band one line tall is the wrong place
  // for a paragraph.
  it('drops Stop once the breaker has tripped, and says the autopilot stopped', () => {
    const el = column({ ...armed, breakerOpen: true });

    expect(el.textContent).toContain('Autopilot is stopped');
    expect(byLabel(el, 'Stop the autopilot')).toBeNull();
  });

  // The whole point of the wording: a Stop that silently left an agent working
  // would be read as broken, so the control says what it does not do.
  it('says that a running task is left alone', () => {
    const el = column(armed);
    const stop = byLabel(el, 'Stop the autopilot');

    expect(stop?.getAttribute('title')).toContain('already running is left');
  });
});
