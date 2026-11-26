// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { stubResizeObserver } from '../__tests__/stub-resize-observer';
import { bareThreadIdentity } from '../components/thread-head';
import {
  faceWidthOf,
  fitFaces,
  type StripThread,
  WorkingStrip,
} from './working-strip';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function threadOf(
  runId: string,
  title: string,
  project: string | null = 'Billing',
): StripThread {
  return {
    runId,
    identity: {
      ...bareThreadIdentity(title),
      face: { kind: 'unknown' },
      project,
      status: { attention: 'working', text: 'Working' },
    },
    statusText: 'Working',
  };
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

  it('draws one face per thread in the order given, each with its working dot', () => {
    draw([threadOf('run-b', 'Second'), threadOf('run-a', 'First')]);
    expect(facesOf()).toEqual(['run-b', 'run-a']);
    expect(
      container.querySelectorAll('[data-slot="working-strip-dot"]'),
    ).toHaveLength(2);
    expect(
      container.querySelector('[data-slot="working-strip-dot"]')!.className,
    ).toContain('animate-pulse');
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
    stubResizeObserver();
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
});

describe('fitFaces', () => {
  it('fits every face when they fit without a "+N"', () => {
    expect(fitFaces([24, 24, 24], 80, 4, 32)).toBe(3);
  });

  it('fits as many faces as stand beside a "+N" when they do not all fit', () => {
    expect(fitFaces([24, 24, 24, 24], 80, 4, 32)).toBe(1);
    expect(fitFaces([24, 24, 24, 24], 96, 4, 32)).toBe(2);
  });

  it('never fits fewer than one face', () => {
    expect(fitFaces([24, 24], 10, 4, 32)).toBe(1);
  });

  it('counts a team stack at its real width', () => {
    expect(faceWidthOf({ kind: 'manager' })).toBe(24);
    expect(
      faceWidthOf({
        kind: 'team',
        people: [
          { key: 'a', name: 'A' },
          { key: 'b', name: 'B' },
        ],
        total: 2,
      }),
    ).toBe(34);
    expect(
      faceWidthOf({
        kind: 'team',
        people: [
          { key: 'a', name: 'A' },
          { key: 'b', name: 'B' },
          { key: 'c', name: 'C' },
          { key: 'd', name: 'D' },
        ],
        total: 5,
      }),
    ).toBe(62);
  });
});
