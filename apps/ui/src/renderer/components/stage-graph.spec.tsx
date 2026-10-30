// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { settleStageGraphs } from '../__tests__/settle-stage-graphs';
import { StageGraph, type StageGraphStage, stageLayout } from './stage-graph';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let observed: { callback: (entries: unknown[]) => void; target: Element }[] =
  [];
const originalObserver = (globalThis as { ResizeObserver?: unknown })
  .ResizeObserver;

class StubResizeObserver {
  private readonly callback: (entries: unknown[]) => void;
  constructor(callback: (entries: unknown[]) => void) {
    this.callback = callback;
  }
  observe(target: Element): void {
    observed.push({ callback: this.callback, target });
  }
  unobserve(): void {}
  disconnect(): void {
    observed = observed.filter((each) => each.callback !== this.callback);
  }
}

async function paint(element: React.ReactElement): Promise<void> {
  act(() => root.render(element));
  await settleStageGraphs(container);
}

async function resizeTo(width: number): Promise<void> {
  act(() => {
    for (const { callback, target } of observed) {
      if (target.matches('[data-slot="stage-graph-room"]')) {
        callback([{ contentRect: { width } }]);
      }
    }
  });
  await settleStageGraphs(container);
}

beforeEach(() => {
  observed = [];
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver =
    StubResizeObserver;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver =
    originalObserver;
});

const stage = (id: string, next?: string[]): StageGraphStage => ({
  id,
  title: id.toUpperCase(),
  ...(next ? { next } : {}),
});

const FORK: StageGraphStage[] = [
  { id: 'a', title: 'Investigation', next: ['b', 'c'] },
  { id: 'b', title: 'Implementation', next: ['d'] },
  { id: 'c', title: 'Fix', next: ['d'] },
  { id: 'd', title: 'Review' },
];

const pill = (id: string): HTMLElement =>
  container.querySelector<HTMLElement>(
    `[data-slot="stage-pill"][data-stage-id="${id}"]`,
  )!;
const pills = (): HTMLElement[] => [
  ...container.querySelectorAll<HTMLElement>('[data-slot="stage-pill"]'),
];
const titleOf = (each: HTMLElement): string =>
  each.querySelector('[data-slot="stage-pill-title"]')!.textContent!;
const columns = (): string[][] => {
  const out: string[][] = [];
  for (const each of pills()) {
    (out[Number(each.dataset.column)] ??= []).push(titleOf(each));
  }
  return out;
};
const edgeEls = (): SVGPathElement[] => [
  ...container.querySelectorAll<SVGPathElement>('[data-slot="stage-edge"]'),
];
const edges = (): Record<string, string | undefined> =>
  Object.fromEntries(
    edgeEls().map((edge) => [edge.dataset.edge, edge.dataset.highlight]),
  );
const canvas = (): HTMLElement =>
  container.querySelector<HTMLElement>('[data-slot="stage-graph-canvas"]')!;
const press = (el: Element): void =>
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });

describe('stageLayout', () => {
  const ids = (layout: { columns: StageGraphStage[][] }): string[][] =>
    layout.columns.map((column) => column.map((s) => s.id));

  it('puts a stage at its longest-path depth, a fork’s branches in one column', () => {
    expect(
      ids(stageLayout([stage('a', ['b', 'c']), stage('b', ['c']), stage('c')])),
    ).toEqual([['a'], ['b'], ['c']]);
    const layout = stageLayout(FORK);
    expect(ids(layout)).toEqual([['a'], ['b', 'c'], ['d']]);
    expect([...layout.backEdges]).toEqual([]);
    expect([...layout.loopEdges]).toEqual([]);
  });

  it('lays out a looping graph by setting the edge back to the loop aside', () => {
    const layout = stageLayout([
      stage('a', ['b']),
      stage('b', ['c']),
      stage('c', ['b', 'd']),
      stage('d'),
    ]);
    expect(ids(layout)).toEqual([['a'], ['b'], ['c'], ['d']]);
    expect([...layout.backEdges]).toEqual(['c>b']);
    expect([...layout.loopEdges].sort()).toEqual(['b>c', 'c>b']);
  });

  it('draws a stage that names itself as a loop of one', () => {
    const layout = stageLayout([stage('a', ['a'])]);
    expect(ids(layout)).toEqual([['a']]);
    expect([...layout.backEdges]).toEqual(['a>a']);
    expect([...layout.loopEdges]).toEqual(['a>a']);
  });

  it('starts the walk at the stage nothing names, whatever its place', () => {
    const layout = stageLayout([
      stage('c', ['b']),
      stage('b', ['c']),
      stage('a', ['b']),
    ]);
    expect([...layout.backEdges]).toEqual(['c>b']);
    expect(ids(layout)).toEqual([['a'], ['b'], ['c']]);
  });

  it('leaves out a second stage under one id and a next naming no stage', () => {
    const layout = stageLayout([
      stage('a', ['b', 'ghost']),
      stage('b'),
      { id: 'a', title: 'Again' },
    ]);
    expect(ids(layout)).toEqual([['a'], ['b']]);
  });
});

describe('StageGraph', () => {
  it('draws a React Flow node per stage in columns by depth, and a line per next', async () => {
    await paint(<StageGraph stages={FORK} />);
    expect(container.querySelector('.react-flow')).not.toBeNull();
    expect(columns()).toEqual([
      ['Investigation'],
      ['Implementation', 'Fix'],
      ['Review'],
    ]);
    expect(Object.keys(edges()).sort()).toEqual(['a>b', 'a>c', 'b>d', 'c>d']);
    expect(canvas().getAttribute('aria-label')).toBe(
      'Stages: Investigation → Implementation or Fix → Review',
    );
  });

  it('shows a placeholder until the layout lands', () => {
    act(() => root.render(<StageGraph stages={FORK} />));
    expect(
      container.querySelector('[data-slot="stage-graph-pending"]'),
    ).not.toBeNull();
    expect(pills()).toEqual([]);
  });

  it('splits a fork: its lines leave one side of one pill and end at two heights', async () => {
    await paint(<StageGraph stages={FORK} />);
    const points = (key: string): number[][] =>
      container
        .querySelector(`[data-edge="${key}"]`)!
        .getAttribute('d')!
        .split(/[MLQ]/)
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => part.split(' ').map(Number));
    const startX = (key: string): number => points(key)[0]![0]!;
    const endY = (key: string): number => points(key).at(-1)!.at(-1)!;
    expect(startX('a>b')).toBe(startX('a>c'));
    expect(endY('a>b')).not.toBe(endY('a>c'));
  });

  it('ends every line in an arrowhead', async () => {
    await paint(<StageGraph stages={FORK} />);
    expect(
      container.querySelectorAll('[data-slot="stage-edge-arrow"]'),
    ).toHaveLength(4);
  });

  describe('fitting its container', () => {
    const drawnWidth = (): number => parseFloat(canvas().style.width);
    const cut = (): string[] =>
      pills()
        .filter((each) => each.dataset.cut === 'true')
        .map((each) => each.dataset.stageId!);

    it('draws at its natural size in a roomy container, no title cut', async () => {
      await paint(<StageGraph stages={FORK} />);
      const natural = drawnWidth();
      await resizeTo(natural + 400);
      expect(drawnWidth()).toBe(natural);
      expect(cut()).toEqual([]);
    });

    it('cuts the widest titles to fit a narrow container without scrolling', async () => {
      await paint(<StageGraph stages={FORK} />);
      const natural = drawnWidth();
      const narrow = Math.round(natural * 0.8);
      await resizeTo(narrow);
      expect(drawnWidth()).toBeLessThanOrEqual(narrow);
      expect(cut()).toContain('b');
      expect(cut()).not.toContain('c');
      expect(pill('b').getAttribute('title')).toBe('Implementation');
      expect(pill('b').getAttribute('aria-label')).toBe('Implementation');
      expect(titleOf(pill('b'))).toBe('Implementation');
    });

    it('overflows only when the shortest pills cannot fit', async () => {
      await paint(<StageGraph stages={FORK} />);
      await resizeTo(60);
      expect(drawnWidth()).toBeGreaterThan(60);
      expect(
        container.querySelector('[data-slot="stage-graph"]')!.className,
      ).toContain('overflow-x-auto');
    });

    it('grows back to whole titles when the container widens again', async () => {
      await paint(<StageGraph stages={FORK} />);
      const natural = drawnWidth();
      await resizeTo(Math.round(natural * 0.8));
      await resizeTo(natural + 100);
      expect(drawnWidth()).toBe(natural);
      expect(cut()).toEqual([]);
    });

    it('fits the width it is handed instead of measuring', async () => {
      await paint(<StageGraph stages={FORK} />);
      const natural = drawnWidth();
      await paint(
        <StageGraph stages={FORK} fitWidth={Math.round(natural * 0.8)} />,
      );
      expect(drawnWidth()).toBeLessThanOrEqual(Math.round(natural * 0.8));
    });
  });

  it('cuts an over-long title and keeps it whole in the tooltip', async () => {
    const long = 'Investigate every failing integration test in the suite';
    await paint(<StageGraph stages={[{ id: 'a', title: long }]} />);
    expect(pill('a').dataset.cut).toBe('true');
    expect(pill('a').getAttribute('title')).toBe(long);
    expect(pill('a').getAttribute('aria-label')).toBe(long);
  });

  it('draws nothing for no stages', async () => {
    await paint(<StageGraph stages={[]} />);
    expect(container.innerHTML).toBe('');
  });

  it('traces a pointed-at pill’s lines, dims the rest, and clears on leaving', async () => {
    await paint(<StageGraph stages={FORK} />);
    expect(new Set(Object.values(edges()))).toEqual(new Set(['none']));

    act(() => {
      pill('b').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(edges()).toEqual({
      'a>b': 'on',
      'b>d': 'on',
      'a>c': 'dim',
      'c>d': 'dim',
    });
    expect(
      ['a', 'b', 'c', 'd'].map((id) => pill(id).dataset.highlight),
    ).toEqual(['on', 'on', 'dim', 'on']);
    expect(
      container.querySelector<SVGPathElement>('[data-edge="a>b"]')!.dataset
        .tone,
    ).toBe('active');

    act(() => {
      pill('b').dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    });
    expect(new Set(Object.values(edges()))).toEqual(new Set(['none']));
    expect(pill('c').dataset.highlight).toBe('none');
  });

  it('is read-only without onSelect: no pill is a button or takes focus', async () => {
    await paint(<StageGraph stages={FORK} />);
    expect(pills().map((each) => each.getAttribute('role'))).toEqual([
      'img',
      'img',
      'img',
      'img',
    ]);
    expect(pills().some((each) => each.hasAttribute('tabindex'))).toBe(false);
  });

  it('hands a pressed or keyed pill to onSelect, and marks the selected one', async () => {
    const onSelect = vi.fn();
    await paint(
      <StageGraph stages={FORK} selectedId="c" onSelect={onSelect} />,
    );
    expect(pill('b').getAttribute('role')).toBe('button');
    expect(pill('b').getAttribute('tabindex')).toBe('0');
    press(pill('b'));
    expect(onSelect).toHaveBeenLastCalledWith('b');
    act(() => {
      pill('d').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
    expect(onSelect).toHaveBeenLastCalledWith('d');
    expect(pill('c').getAttribute('aria-current')).toBe('true');
    expect(pill('a').getAttribute('aria-current')).toBeNull();
  });

  it('flags a failing stage with an icon and in its name, not by colour alone', async () => {
    await paint(<StageGraph stages={FORK} errorIds={new Set(['d'])} />);
    expect(pill('d').dataset.error).toBe('true');
    expect(pill('d').getAttribute('aria-label')).toBe('Review, has an error');
    expect(
      pill('d')
        .querySelector('[data-slot="stage-pill-icon"]')
        ?.getAttribute('data-icon'),
    ).toBe('error');
    expect(pill('c').dataset.error).toBeUndefined();
    expect(pill('c').querySelector('[data-slot="stage-pill-icon"]')).toBeNull();
  });

  it('draws a loop instead of refusing it, its lines dashed, and says so', async () => {
    await paint(
      <StageGraph
        stages={[stage('a', ['b']), stage('b', ['c']), stage('c', ['b'])]}
      />,
    );
    expect(
      edgeEls()
        .map((edge) => [
          edge.dataset.edge,
          edge.dataset.loop ?? null,
          edge.getAttribute('stroke-dasharray'),
        ])
        .sort(),
    ).toEqual([
      ['a>b', null, null],
      ['b>c', 'true', '4 3'],
      ['c>b', 'true', '4 3'],
    ]);
    expect(canvas().getAttribute('aria-label')).toBe(
      'Stages, which loop back on themselves: A, B, C',
    );
  });

  describe('with a run’s statuses', () => {
    const RUN: StageGraphStage[] = [
      { id: 'a', title: 'Investigation', next: ['b', 'c'], status: 'done' },
      { id: 'b', title: 'Implementation', next: ['d'], status: 'not_taken' },
      { id: 'c', title: 'Fix', next: ['d'], status: 'current' },
      { id: 'd', title: 'Review', next: ['e'], status: 'pending' },
      { id: 'e', title: 'Docs', status: 'skipped' },
    ];

    it('names each pill’s status and marks it with a glyph, the pending one plain', async () => {
      await paint(<StageGraph stages={RUN} />);
      expect(
        ['a', 'b', 'c', 'd', 'e'].map((id) => [
          pill(id).getAttribute('aria-label'),
          pill(id)
            .querySelector('[data-slot="stage-pill-icon"]')
            ?.getAttribute('data-icon') ?? null,
        ]),
      ).toEqual([
        ['Investigation, done', 'done'],
        ['Implementation, not taken', 'not_taken'],
        ['Fix, current', 'current'],
        ['Review, pending', null],
        ['Docs, skipped', 'skipped'],
      ]);
    });

    it('rings the current stage blue and a failing one red', async () => {
      await paint(<StageGraph stages={RUN} errorIds={new Set(['d'])} />);
      expect(
        ['a', 'b', 'c', 'd', 'e'].map((id) => pill(id).dataset.ring),
      ).toEqual([undefined, undefined, 'current', 'failed', undefined]);
      expect(pill('c').className).toContain('ring-primary/20');
      expect(pill('d').className).toContain('ring-destructive/25');
    });

    it('outlines an untaken branch dashed', async () => {
      await paint(<StageGraph stages={RUN} />);
      expect(pill('b').className).toContain('border-dashed');
      expect(pill('c').className).not.toContain('border-dashed');
    });

    it('tones the walked lines apart from the untaken and the ones ahead', async () => {
      await paint(<StageGraph stages={RUN} />);
      const tones = Object.fromEntries(
        edgeEls().map((edge) => [edge.dataset.edge, edge.dataset.tone]),
      );
      expect(tones).toEqual({
        'a>b': 'untaken',
        'a>c': 'walked',
        'b>d': 'untaken',
        'c>d': 'plain',
        'd>e': 'plain',
      });
      expect(
        container.querySelector('[data-edge="a>c"]')!.getAttribute('class'),
      ).toContain('stroke-success');
    });
  });
});
