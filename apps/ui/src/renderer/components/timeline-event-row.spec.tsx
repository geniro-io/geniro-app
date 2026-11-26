// @vitest-environment jsdom
import { Play, ShieldAlert } from 'lucide-react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  TimelineEventRow,
  type TimelineEventRowProps,
  type TimelineTone,
} from './timeline-event-row';

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

const AT = new Date('2026-11-17T11:58:00').toISOString();

/** Draws one row in a list, replacing any row drawn before. */
function draw(over: Partial<TimelineEventRowProps> = {}): HTMLElement {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const props: TimelineEventRowProps = {
    icon: Play,
    tone: 'success',
    sentence: 'Billing export started',
    at: AT,
    ...over,
  };
  act(() => {
    root!.render(
      <ol>
        <TimelineEventRow {...props} />
      </ol>,
    );
  });
  return container;
}

function buttonNamed(el: HTMLElement, label: string): HTMLButtonElement {
  return el.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
}

describe('TimelineEventRow — activation', () => {
  it('exposes the activator under its activateLabel', () => {
    const el = draw({
      onActivate: vi.fn(),
      activateLabel: 'Show Billing export on the canvas',
    });

    expect(buttonNamed(el, 'Show Billing export on the canvas')).not.toBeNull();
  });

  it('calls onActivate once when the activator is pressed', () => {
    const onActivate = vi.fn();
    const el = draw({ onActivate, activateLabel: 'Show it' });

    act(() => {
      buttonNamed(el, 'Show it').click();
    });

    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it('does not call onActivate when an action in the row is pressed', () => {
    const onActivate = vi.fn();
    const onAction = vi.fn();
    const el = draw({
      onActivate,
      activateLabel: 'Show it',
      actions: (
        <button type="button" onClick={onAction}>
          Reply
        </button>
      ),
    });
    const reply = [...el.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Reply',
    )!;

    act(() => {
      reply.click();
    });

    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onActivate).not.toHaveBeenCalled();
  });

  it('is a plain list item with no button when it has no onActivate', () => {
    const el = draw();

    expect(el.querySelector('li')).not.toBeNull();
    expect(el.querySelector('button')).toBeNull();
  });
});

describe('TimelineEventRow — content', () => {
  it('shows the detail line when one is given', () => {
    const el = draw({ detail: 'Opened by the manager' });

    expect(el.querySelector('.line-clamp-2')!.textContent).toBe(
      'Opened by the manager',
    );
  });

  it('draws no detail line when none is given, null or undefined', () => {
    expect(draw().querySelector('.line-clamp-2')).toBeNull();
    expect(draw({ detail: null }).querySelector('.line-clamp-2')).toBeNull();
  });

  it('draws the badge and the actions it is given', () => {
    const el = draw({
      badge: <span>awaiting reply</span>,
      actions: <button type="button">Reply</button>,
    });

    expect(el.textContent).toContain('awaiting reply');
    expect(el.querySelector('button')!.textContent).toBe('Reply');
  });

  it('shows the clock time, with the full date as its title', () => {
    const el = draw();
    const time = el.querySelector('time')!;

    expect(time.textContent).toBe('11:58');
    expect(time.getAttribute('datetime')).toBe(AT);
    expect(time.getAttribute('title')).toBe(new Date(AT).toLocaleString());
  });

  it('puts its data attributes on the row', () => {
    const el = draw({
      data: { 'data-slot': 'timeline-event', 'data-kind': 'stage' },
    });
    const row = el.querySelector('li')!;

    expect(row.getAttribute('data-slot')).toBe('timeline-event');
    expect(row.getAttribute('data-kind')).toBe('stage');
  });
});

describe('TimelineEventRow — meta', () => {
  it('draws the meta line under the sentence when one is given', () => {
    const el = draw({ meta: <span>Geniro · started</span> });

    expect(
      el.querySelector('[data-slot="timeline-event-meta"]')!.textContent,
    ).toBe('Geniro · started');
  });

  it('draws no meta line when none is given, null or undefined', () => {
    expect(
      draw().querySelector('[data-slot="timeline-event-meta"]'),
    ).toBeNull();
    expect(
      draw({ meta: null }).querySelector('[data-slot="timeline-event-meta"]'),
    ).toBeNull();
  });
});

describe('TimelineEventRow — live', () => {
  it('draws a pulsing dot when the row is live', () => {
    const el = draw({ live: true });

    const dot = el.querySelector<HTMLElement>(
      '[data-slot="timeline-live-dot"]',
    );
    expect(dot).not.toBeNull();
    expect(dot!.className).toContain('motion-safe:animate-pulse');
  });

  it('draws no dot when the row is not live', () => {
    const el = draw();

    expect(el.querySelector('[data-slot="timeline-live-dot"]')).toBeNull();
  });
});

describe('TimelineEventRow — tone', () => {
  it.each<[TimelineTone, string]>([
    ['primary', 'text-primary'],
    ['success', 'text-success'],
    ['warning', 'text-warning'],
    ['destructive', 'text-destructive'],
    ['accent', 'text-accent-foreground'],
    ['muted', 'text-muted-foreground'],
  ])('colours a %s row with %s on its icon', (tone, colour) => {
    const el = draw({ tone, icon: ShieldAlert });

    expect(el.querySelector('svg')!.parentElement!.className).toContain(colour);
  });
});
