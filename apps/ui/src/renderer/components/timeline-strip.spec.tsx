// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  type TimelineMarker,
  TimelineStrip,
  type TimelineStripProps,
} from './timeline-strip';

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

const RANGE = {
  start: '2026-11-17T10:00:00.000Z',
  end: '2026-11-17T14:00:00.000Z',
};

const at = (hour: number): string =>
  `2026-11-17T${String(hour).padStart(2, '0')}:00:00.000Z`;

function render(props: Partial<TimelineStripProps> = {}): HTMLDivElement {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <TimelineStrip {...RANGE} spans={[]} markers={[]} {...props} />,
    );
  });
  return container;
}

const spanOf = (el: HTMLElement, index: number): HTMLElement =>
  el.querySelectorAll<HTMLElement>('[data-slot="timeline-span"]')[index]!;

const markerNamed = (el: HTMLElement, label: string): HTMLElement =>
  el.querySelector<HTMLElement>(`[aria-label^="${label}"]`)!;

describe('TimelineStrip — span placement', () => {
  it('places a closed span at its fractions of the range', () => {
    const el = render({
      spans: [{ kind: 'work', start: at(11), end: at(12) }],
    });

    expect(spanOf(el, 0).style.left).toBe('25%');
    expect(spanOf(el, 0).style.width).toBe('25%');
  });

  it('runs an open span to the right edge of the range', () => {
    const el = render({
      spans: [{ kind: 'waiting', start: at(13), end: null }],
    });

    expect(spanOf(el, 0).style.left).toBe('75%');
    expect(spanOf(el, 0).style.width).toBe('25%');
  });

  it('clamps a span that runs past both ends of the range to the whole strip', () => {
    const el = render({
      spans: [{ kind: 'work', start: at(8), end: at(16) }],
    });

    expect(spanOf(el, 0).style.left).toBe('0%');
    expect(spanOf(el, 0).style.width).toBe('100%');
  });

  it('draws a span lying wholly after the range as zero width at the right edge', () => {
    const el = render({
      spans: [{ kind: 'work', start: at(15), end: at(16) }],
    });

    expect(spanOf(el, 0).style.left).toBe('100%');
    expect(spanOf(el, 0).style.width).toBe('0%');
  });

  it('draws a span lying wholly before the range as zero width at the left edge', () => {
    const el = render({
      spans: [{ kind: 'work', start: at(7), end: at(9) }],
    });

    expect(spanOf(el, 0).style.left).toBe('0%');
    expect(spanOf(el, 0).style.width).toBe('0%');
  });

  it('keeps work and waiting spans visually distinct', () => {
    const el = render({
      spans: [
        { kind: 'work', start: at(10), end: at(11) },
        { kind: 'waiting', start: at(11), end: at(12) },
      ],
    });

    const work = spanOf(el, 0).className;
    const waiting = spanOf(el, 1).className;
    expect(spanOf(el, 0).dataset.kind).toBe('work');
    expect(spanOf(el, 1).dataset.kind).toBe('waiting');
    expect(work).not.toBe(waiting);
  });
});

describe('TimelineStrip — markers', () => {
  it('places a marker at its fraction of the range', () => {
    const el = render({
      markers: [{ kind: 'question', at: at(12), label: null }],
    });

    expect(markerNamed(el, 'Question').style.left).toBe('50%');
  });

  it('clamps a marker before the range to the left edge and one after it to the right', () => {
    const el = render({
      markers: [
        { kind: 'failure', at: at(9), label: null },
        { kind: 'pr_merged', at: at(20), label: null },
      ],
    });

    expect(markerNamed(el, 'Failure').style.left).toBe('0%');
    expect(markerNamed(el, 'PR merged').style.left).toBe('100%');
  });

  it('names each marker by its kind, its label and its time', () => {
    const el = render({
      markers: [
        { kind: 'user_message', at: at(11), label: 'Fix the login' },
        { kind: 'pr_opened', at: at(12), label: null },
      ],
    });

    const named = markerNamed(el, 'Your message');
    expect(named.getAttribute('aria-label')).toMatch(
      /^Your message: Fix the login \(\d{1,2}:\d{2}.*\)$/,
    );
    expect(named.getAttribute('title')).toBe(named.getAttribute('aria-label'));
    expect(markerNamed(el, 'PR opened').getAttribute('aria-label')).toMatch(
      /^PR opened \(\d{1,2}:\d{2}.*\)$/,
    );
  });

  it('calls onMarker with the marker that was pressed', () => {
    const onMarker = vi.fn();
    const marker: TimelineMarker = {
      kind: 'stage',
      at: at(13),
      label: 'build',
    };
    const el = render({ markers: [marker], onMarker });

    act(() => {
      markerNamed(el, 'Stage').click();
    });

    expect(onMarker).toHaveBeenCalledWith(marker);
  });

  it('renders markers as focusable buttons', () => {
    const el = render({
      markers: [{ kind: 'manager_in', at: at(11), label: null }],
    });

    const button = el.querySelector('button[data-slot="timeline-marker"]');
    expect(button).not.toBeNull();
    expect(button!.getAttribute('type')).toBe('button');
  });
});

describe('TimelineStrip — now tick and motion', () => {
  it('draws the now tick at the right edge', () => {
    const el = render();

    const now = el.querySelector<HTMLElement>('[data-slot="timeline-now"]');
    expect(now).not.toBeNull();
    expect(now!.className).toContain('right-0');
  });

  it('pulses the now tick only while a span is open', () => {
    const open = render({
      spans: [{ kind: 'work', start: at(11), end: null }],
    });
    expect(
      open.querySelector('[data-slot="timeline-now"]')!.className,
    ).toContain('motion-safe:animate-pulse');

    const closed = render({
      spans: [{ kind: 'work', start: at(11), end: at(12) }],
    });
    expect(
      closed.querySelector('[data-slot="timeline-now"]')!.className,
    ).not.toContain('animate-pulse');
  });

  it('gates the pulse behind the reduced-motion preference', () => {
    const el = render({
      spans: [{ kind: 'work', start: at(11), end: null }],
    });

    const classes = el
      .querySelector('[data-slot="timeline-now"]')!
      .className.split(/\s+/);
    expect(classes).toContain('motion-safe:animate-pulse');
    expect(classes).toContain('motion-reduce:animate-none');
    expect(classes).not.toContain('animate-pulse');
  });
});
