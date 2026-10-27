// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StageGraph, type StageGraphStage, stageLayout } from './stage-graph';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let observed: ((entries: unknown[]) => void)[] = [];
const originalObserver = (globalThis as { ResizeObserver?: unknown })
  .ResizeObserver;

class StubResizeObserver {
  private readonly callback: (entries: unknown[]) => void;
  constructor(callback: (entries: unknown[]) => void) {
    this.callback = callback;
  }
  observe(): void {
    observed.push(this.callback);
  }
  unobserve(): void {}
  disconnect(): void {
    observed = observed.filter((each) => each !== this.callback);
  }
}

const resizeTo = (width: number): void =>
  act(() => {
    for (const callback of observed) {
      callback([{ contentRect: { width } }]);
    }
  });

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

const pill = (id: string): SVGGElement =>
  container.querySelector<SVGGElement>(
    `[data-slot="stage-pill"][data-stage-id="${id}"]`,
  )!;
const pills = (): SVGGElement[] => [
  ...container.querySelectorAll<SVGGElement>('[data-slot="stage-pill"]'),
];
const columns = (): string[][] => {
  const out: string[][] = [];
  for (const each of pills()) {
    (out[Number(each.dataset.column)] ??= []).push(
      each.querySelector('text')!.textContent!,
    );
  }
  return out;
};
const edges = (): Record<string, string | undefined> =>
  Object.fromEntries(
    [
      ...container.querySelectorAll<SVGPathElement>('[data-slot="stage-edge"]'),
    ].map((edge) => [edge.dataset.edge, edge.dataset.highlight]),
  );
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
  it('draws a pill per stage in columns by depth, and a line per next', () => {
    act(() => root.render(<StageGraph stages={FORK} />));
    expect(columns()).toEqual([
      ['Investigation'],
      ['Implementation', 'Fix'],
      ['Review'],
    ]);
    expect(Object.keys(edges()).sort()).toEqual(['a>b', 'a>c', 'b>d', 'c>d']);
    expect(container.querySelector('svg')!.getAttribute('aria-label')).toBe(
      'Stages: Investigation → Implementation or Fix → Review',
    );
  });

  it('splits a fork into rows: its lines leave one pill and end at two heights', () => {
    act(() => root.render(<StageGraph stages={FORK} />));
    const path = (key: string): string =>
      container.querySelector(`[data-edge="${key}"]`)!.getAttribute('d')!;
    const start = (key: string): string => path(key).split(' C ')[0]!;
    const end = (key: string): string => path(key).split(', ').at(-1)!;
    expect(start('a>b')).toBe(start('a>c'));
    expect(end('a>b').split(' ')[1]).not.toBe(end('a>c').split(' ')[1]);
  });

  describe('fitting its container', () => {
    const NATIVE_TEXT_PX = 12;
    const svg = (): SVGSVGElement => container.querySelector('svg')!;
    const naturalWidth = (): number =>
      Number(svg().getAttribute('viewBox')!.split(' ')[2]);
    const drawnWidth = (): number => Number(svg().getAttribute('width'));
    const textPx = (): number =>
      (NATIVE_TEXT_PX * drawnWidth()) / naturalWidth();
    const labels = (): string[] =>
      pills().map((each) => each.querySelector('text')!.textContent!);

    it('draws at its natural size in a roomy container, text unscaled', () => {
      act(() => root.render(<StageGraph stages={FORK} />));
      const natural = drawnWidth();
      resizeTo(natural + 400);
      expect(drawnWidth()).toBe(natural);
      expect(textPx()).toBe(NATIVE_TEXT_PX);
      expect(labels()).toEqual([
        'Investigation',
        'Implementation',
        'Fix',
        'Review',
      ]);
    });

    it('cuts titles with an ellipsis to fit a narrow container without scrolling', () => {
      act(() => root.render(<StageGraph stages={FORK} />));
      const natural = drawnWidth();
      const narrow = Math.round(natural * 0.8);
      resizeTo(narrow);
      expect(drawnWidth()).toBeLessThanOrEqual(narrow);
      expect(labels().some((label) => label.endsWith('…'))).toBe(true);
      expect(labels()[2]).toBe('Fix');
      expect(pill('b').getAttribute('title')).toBe('Implementation');
      expect(pill('b').getAttribute('aria-label')).toBe('Implementation');
      expect(textPx()).toBeGreaterThanOrEqual(10);
    });

    it('never shrinks the text, and overflows only when minimum pills cannot fit', () => {
      act(() => root.render(<StageGraph stages={FORK} />));
      const natural = drawnWidth();
      resizeTo(Math.round(natural * 0.8));
      expect(drawnWidth()).toBeLessThanOrEqual(Math.round(natural * 0.8));
      resizeTo(60);
      expect(drawnWidth()).toBeGreaterThan(60);
      expect(textPx()).toBeGreaterThanOrEqual(10);
      expect(
        container.querySelector('[data-slot="stage-graph"]')!.className,
      ).toContain('overflow-x-auto');
    });

    it('grows back to full titles when the container widens again', () => {
      act(() => root.render(<StageGraph stages={FORK} />));
      const natural = drawnWidth();
      resizeTo(Math.round(natural * 0.8));
      resizeTo(natural + 100);
      expect(drawnWidth()).toBe(natural);
      expect(labels()[1]).toBe('Implementation');
    });
  });

  it('cuts a long title with an ellipsis and keeps it whole in the tooltip', () => {
    const long = 'Investigate every failing integration test';
    act(() => root.render(<StageGraph stages={[{ id: 'a', title: long }]} />));
    expect(pill('a').querySelector('text')!.textContent).toBe(
      'Investigate every failing…',
    );
    expect(pill('a').getAttribute('title')).toBe(long);
    expect(pill('a').querySelector('title')).toBeNull();
    expect(pill('a').getAttribute('aria-label')).toBe(long);
  });

  it('draws nothing for no stages', () => {
    act(() => root.render(<StageGraph stages={[]} />));
    expect(container.innerHTML).toBe('');
  });

  it('traces a pointed-at pill’s lines, dims the rest, and clears on leaving', () => {
    act(() => root.render(<StageGraph stages={FORK} />));
    expect(new Set(Object.values(edges()))).toEqual(new Set(['none']));

    act(() => {
      pill('b').dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
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
      pill('b').dispatchEvent(new MouseEvent('pointerout', { bubbles: true }));
    });
    expect(new Set(Object.values(edges()))).toEqual(new Set(['none']));
    expect(pill('c').dataset.highlight).toBe('none');
  });

  it('is read-only without onSelect: no pill is a button or takes focus', () => {
    act(() => root.render(<StageGraph stages={FORK} />));
    expect(pills().map((each) => each.getAttribute('role'))).toEqual([
      'img',
      'img',
      'img',
      'img',
    ]);
    expect(pills().some((each) => each.hasAttribute('tabindex'))).toBe(false);
  });

  it('hands a pressed or keyed pill to onSelect, and marks the selected one', () => {
    const onSelect = vi.fn();
    act(() =>
      root.render(
        <StageGraph stages={FORK} selectedId="c" onSelect={onSelect} />,
      ),
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

  it('flags a failing stage with an icon and in its name, not by colour alone', () => {
    act(() =>
      root.render(<StageGraph stages={FORK} errorIds={new Set(['d'])} />),
    );
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

  it('draws a loop instead of refusing it, its lines dashed, and says so', () => {
    act(() =>
      root.render(
        <StageGraph
          stages={[stage('a', ['b']), stage('b', ['c']), stage('c', ['b'])]}
        />,
      ),
    );
    expect(
      [
        ...container.querySelectorAll<SVGPathElement>(
          '[data-slot="stage-edge"]',
        ),
      ].map((edge) => [
        edge.dataset.edge,
        edge.dataset.loop ?? null,
        edge.getAttribute('stroke-dasharray'),
      ]),
    ).toEqual([
      ['a>b', null, null],
      ['b>c', 'true', '4 3'],
      ['c>b', 'true', '4 3'],
    ]);
    expect(container.querySelector('svg')!.getAttribute('aria-label')).toBe(
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

    it('names each pill’s status and marks it with a glyph, the pending one plain', () => {
      act(() => root.render(<StageGraph stages={RUN} />));
      expect(
        pills().map((each) => [
          each.getAttribute('aria-label'),
          each
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

    it('tints the ring red for a failing stage and blue for the current one', () => {
      act(() =>
        root.render(<StageGraph stages={RUN} errorIds={new Set(['d'])} />),
      );
      const ring = (id: string): string | null =>
        pill(id)
          .querySelector('[data-slot="stage-pill-ring"]')
          ?.getAttribute('class') ?? null;
      expect(ring('c')).toContain('stroke-primary');
      expect(ring('d')).toContain('stroke-destructive');
    });

    it('outlines an untaken branch dashed and rings the current stage', () => {
      act(() => root.render(<StageGraph stages={RUN} />));
      const outline = (id: string): Element =>
        pill(id).querySelector('[data-slot="stage-pill-shape"]')!;
      const ringed = (id: string): boolean =>
        pill(id).querySelector('[data-slot="stage-pill-ring"]') !== null;
      expect(outline('b').getAttribute('stroke-dasharray')).toBe('3 2');
      expect(outline('c').getAttribute('stroke-dasharray')).toBeNull();
      expect(['a', 'b', 'c', 'd', 'e'].map(ringed)).toEqual([
        false,
        false,
        true,
        false,
        false,
      ]);
    });

    it('tones the walked lines apart from the untaken and the ones ahead', () => {
      act(() => root.render(<StageGraph stages={RUN} />));
      const tones = Object.fromEntries(
        [
          ...container.querySelectorAll<SVGPathElement>(
            '[data-slot="stage-edge"]',
          ),
        ].map((edge) => [edge.dataset.edge, edge.dataset.tone]),
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
