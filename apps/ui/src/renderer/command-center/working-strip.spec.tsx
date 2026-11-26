// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { stubResizeObserver } from '../__tests__/stub-resize-observer';
import { stubTopLayer } from '../__tests__/stub-top-layer';
import { bareThreadIdentity } from '../components/thread-head';
import type { ThreadAttention } from '../components/thread-labels';
import { ThreadCard } from './thread-card';
import { fitFaces, type StripThread, WorkingStrip } from './working-strip';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function threadOf(
  runId: string,
  title: string,
  project: string | null = 'Billing',
  attention: ThreadAttention = 'working',
): StripThread {
  return {
    runId,
    identity: {
      ...bareThreadIdentity(title),
      face: { kind: 'unknown' },
      project,
      status: { attention, text: 'Working' },
    },
    attention,
    statusText: 'Working',
  };
}

function frameClassesOfCard(attention: ThreadAttention): string[] {
  const host = document.createElement('div');
  const cardRoot = createRoot(host);
  act(() => {
    cardRoot.render(
      <ThreadCard
        title="Card"
        status="working"
        statusText="Working"
        attention={attention}
        project={null}
        agentLabel={null}
        isTeam={false}
        face={{ kind: 'unknown' }}
        pullRequest={null}
        note={null}
        lastMessage={null}
        boardCard={null}
        idleDays={null}
        lastAt="2026-11-26T10:00:00.000Z"
        now={Date.parse('2026-11-26T10:05:00.000Z')}
        onOpenInChats={() => undefined}
      />,
    );
  });
  const classes = host
    .querySelector('[data-slot="thread-card"]')!
    .className.split(' ')
    .filter(
      (name) =>
        name.startsWith('border-') ||
        name.startsWith('bg-') ||
        name.startsWith('cc-'),
    );
  act(() => {
    cardRoot.unmount();
  });
  return classes;
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.restoreAllMocks();
});

function draw(
  threads: StripThread[],
  onOpenThread: (runId: string) => void = () => undefined,
): void {
  act(() => {
    root.render(<WorkingStrip threads={threads} onOpenThread={onOpenThread} />);
  });
}

function measureFacesAt(face: number, more: number, gap: number): void {
  stubResizeObserver();
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(
    function (this: HTMLElement) {
      if (this.parentElement?.dataset.slot !== 'working-strip-measure') {
        return 0;
      }
      return this.nextElementSibling === null ? more : face;
    },
  );
  vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockImplementation(
    function (this: HTMLElement) {
      const before = this.previousElementSibling;
      return before instanceof HTMLElement
        ? before.offsetLeft + before.offsetWidth + gap
        : 0;
    },
  );
}

function facesOf(): string[] {
  return [
    ...container.querySelectorAll<HTMLElement>(
      '[data-slot="working-strip-thread"]',
    ),
  ].map((face) => face.dataset.run!);
}

describe('WorkingStrip', () => {
  it('draws nothing when no thread works', () => {
    draw([]);
    expect(container.querySelector('[data-slot="working-strip"]')).toBeNull();
  });

  it('draws one face per thread in the order given', () => {
    draw([threadOf('run-b', 'Second'), threadOf('run-a', 'First')]);
    expect(facesOf()).toEqual(['run-b', 'run-a']);
  });

  it("frames a working face in its card's working colours and running border", () => {
    draw([threadOf('run-a', 'First')]);
    const face = container.querySelector<HTMLElement>(
      '[data-slot="working-strip-thread"]',
    )!;
    const cardFrame = frameClassesOfCard('working');
    expect(cardFrame).toContain('cc-running-border');
    expect(cardFrame).toContain('border-success/50');
    expect(face.className.split(' ')).toEqual(
      expect.arrayContaining(cardFrame),
    );
    expect(face.className).not.toContain('bg-primary');
  });

  it("follows the thread's own attention rather than always drawing working", () => {
    draw([threadOf('run-a', 'Asking', 'Billing', 'question')]);
    const face = container.querySelector<HTMLElement>(
      '[data-slot="working-strip-thread"]',
    )!;
    expect(face.dataset.attention).toBe('question');
    expect(face.className.split(' ')).toEqual(
      expect.arrayContaining(frameClassesOfCard('question')),
    );
    expect(face.className).not.toContain('cc-running-border');
  });

  it('titles a face with its title, project and status, and leaves out a missing project', () => {
    draw([
      threadOf('run-a', 'Refactor', 'Billing'),
      threadOf('run-b', 'Plain', null),
    ]);
    const faces = [
      ...container.querySelectorAll<HTMLButtonElement>(
        '[data-slot="working-strip-thread"]',
      ),
    ];
    expect(faces[0]!.title).toBe('Refactor · Billing · Working');
    expect(faces[1]!.title).toBe('Plain · Working');
    expect(faces[0]!.getAttribute('aria-label')).toBe('Open Refactor');
  });

  it('opens the thread of a pressed face', () => {
    const onOpenThread = vi.fn();
    draw([threadOf('run-a', 'First')], onOpenThread);
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-slot="working-strip-thread"]')!
        .click();
    });
    expect(onOpenThread).toHaveBeenCalledWith('run-a');
  });

  it('shows every face while its width is not measured yet', () => {
    draw([
      threadOf('run-a', 'One'),
      threadOf('run-b', 'Two'),
      threadOf('run-c', 'Three'),
      threadOf('run-d', 'Four'),
    ]);
    expect(facesOf()).toHaveLength(4);
    expect(
      container.querySelector('[data-slot="working-strip-more"]'),
    ).toBeNull();
  });

  it('shows as many faces as fit beside a "+N" and lists the rest in a popover', () => {
    measureFacesAt(28, 30, 4);
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(80);
    const onOpenThread = vi.fn();
    draw(
      [
        threadOf('run-a', 'One'),
        threadOf('run-b', 'Two'),
        threadOf('run-c', 'Three'),
        threadOf('run-d', 'Four'),
      ],
      onOpenThread,
    );
    expect(facesOf()).toEqual(['run-a']);
    const more = container.querySelector<HTMLButtonElement>(
      '[data-slot="working-strip-more"]',
    )!;
    expect(more.textContent).toBe('+3');

    act(() => {
      more.click();
    });
    const rows = [
      ...document.querySelectorAll<HTMLButtonElement>(
        '[data-slot="working-strip-row-title"]',
      ),
    ];
    expect(rows.map((row) => row.textContent)).toEqual([
      'Two',
      'Three',
      'Four',
    ]);

    act(() => {
      rows[1]!.click();
    });
    expect(onOpenThread).toHaveBeenCalledWith('run-c');
    expect(
      document.querySelectorAll('[data-slot="working-strip-row-title"]'),
    ).toHaveLength(0);
  });

  it('opens a hidden thread from a press anywhere on its row and closes the popover', () => {
    measureFacesAt(28, 30, 4);
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(80);
    const onOpenThread = vi.fn();
    draw(
      [
        threadOf('run-a', 'One'),
        threadOf('run-b', 'Two'),
        threadOf('run-c', 'Three'),
      ],
      onOpenThread,
    );
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-slot="working-strip-more"]')!
        .click();
    });
    const row = document.querySelector<HTMLButtonElement>(
      '[data-slot="working-strip-row"][data-run="run-b"]',
    )!;
    expect(row.tagName).toBe('BUTTON');
    act(() => {
      row.click();
    });
    expect(onOpenThread).toHaveBeenCalledWith('run-b');
    expect(onOpenThread).toHaveBeenCalledTimes(1);
    expect(
      document.querySelector('[data-slot="working-strip-row"]'),
    ).toBeNull();
  });

  it('lists the hidden threads in the top layer, over cards standing above the manager window', () => {
    const topLayer = stubTopLayer();
    try {
      measureFacesAt(28, 30, 4);
      vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(80);
      vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(
        new DOMRect(40, 10, 30, 24),
      );
      draw([
        threadOf('run-a', 'One'),
        threadOf('run-b', 'Two'),
        threadOf('run-c', 'Three'),
      ]);
      act(() => {
        container
          .querySelector<HTMLButtonElement>('[data-slot="working-strip-more"]')!
          .click();
      });
      const panel = document.querySelector<HTMLElement>(
        '[data-slot="popover-panel"]',
      )!;

      expect(panel.getAttribute('popover')).toBe('manual');
      expect(topLayer.shown).toEqual([panel]);
      expect(
        panel.querySelector(
          '[data-slot="working-strip-row"][data-run="run-b"]',
        ),
      ).not.toBeNull();
    } finally {
      topLayer.restore();
    }
  });

  it('fits the faces by the widths they are drawn at, padding included', () => {
    measureFacesAt(28, 30, 4);
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(200);
    draw(
      ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((key) =>
        threadOf(`run-${key}`, key.toUpperCase()),
      ),
    );
    expect(facesOf()).toEqual(['run-a', 'run-b', 'run-c', 'run-d', 'run-e']);
    expect(
      container.querySelector('[data-slot="working-strip-more"]')!.textContent,
    ).toBe('+2');
  });

  it('draws every face once they all fit at their drawn widths', () => {
    measureFacesAt(28, 30, 4);
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(220);
    draw(
      ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((key) =>
        threadOf(`run-${key}`, key.toUpperCase()),
      ),
    );
    expect(facesOf()).toHaveLength(7);
    expect(
      container.querySelector('[data-slot="working-strip-more"]'),
    ).toBeNull();
  });
});

describe('fitFaces', () => {
  it('fits every face when the last one ends inside the room', () => {
    expect(fitFaces([24, 52, 80], 80, 36)).toBe(3);
  });

  it('fits as many faces as stand beside a "+N" when they do not all fit', () => {
    expect(fitFaces([24, 52, 80, 108], 80, 36)).toBe(1);
    expect(fitFaces([24, 52, 80, 108], 96, 36)).toBe(2);
  });

  it('never fits fewer than one face', () => {
    expect(fitFaces([24, 52], 10, 36)).toBe(1);
  });
});
