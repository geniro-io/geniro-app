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
        onOpenTask={vi.fn()}
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

const armed = { breakerOpen: false, onStop: vi.fn() };

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
