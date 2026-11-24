// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ThreadArchiveContext,
  type ThreadArchiveOf,
} from '../components/thread-archive';
import { TIMELINE_FIXTURE_NOW, timelineFixtures } from './timeline-fixtures';
import {
  isAnswerable,
  type TimelineEvent,
  TimelinePanel,
  type TimelinePanelProps,
} from './timeline-panel';

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

const EVENT_AT = new Date('2026-11-17T10:00:00').toISOString();
const BILLING = { threadRunId: 'run-billing', threadTitle: 'Billing export' };
const RELEASE = { threadRunId: 'run-release', threadTitle: 'Release notes' };

/** A timeline row whose id is `<kind>:<itemId>`, as the daemon writes it. */
function eventOf(
  kind: TimelineEvent['kind'],
  itemId: string,
  over: Partial<TimelineEvent> = {},
): TimelineEvent {
  return {
    id: `${kind}:${itemId}`,
    kind,
    at: EVENT_AT,
    threadRunId: null,
    threadTitle: null,
    text: null,
    detail: null,
    awaitingReply: false,
    ...over,
  };
}

function props(over: Partial<TimelinePanelProps> = {}): TimelinePanelProps {
  return {
    events: timelineFixtures(),
    loading: false,
    error: null,
    hasMore: true,
    onLoadOlder: vi.fn(),
    onShowThread: vi.fn(),
    onReply: vi.fn(),
    openItemIds: new Set(),
    now: TIMELINE_FIXTURE_NOW,
    ...over,
  };
}

/** Draws the panel, inside the archive context when one is given. */
function render(
  over: Partial<TimelinePanelProps> = {},
  archiveOf?: ThreadArchiveOf,
): HTMLElement {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const panel = <TimelinePanel {...props(over)} />;
  act(() => {
    root!.render(
      archiveOf === undefined ? (
        panel
      ) : (
        <ThreadArchiveContext.Provider value={archiveOf}>
          {panel}
        </ThreadArchiveContext.Provider>
      ),
    );
  });
  return container.querySelector<HTMLElement>(
    '[data-slot="command-center-timeline"]',
  )!;
}

function press(button: HTMLElement): void {
  act(() => {
    button.click();
  });
}

function shownKinds(el: HTMLElement): string[] {
  return [
    ...el.querySelectorAll<HTMLElement>('[data-slot="timeline-event"]'),
  ].map((row) => row.dataset.kind ?? '');
}

function rowsOf(el: HTMLElement, kind: TimelineEvent['kind']): HTMLElement[] {
  return [
    ...el.querySelectorAll<HTMLElement>(
      `[data-slot="timeline-event"][data-kind="${kind}"]`,
    ),
  ];
}

function rowOf(el: HTMLElement, kind: TimelineEvent['kind']): HTMLElement {
  return rowsOf(el, kind)[0]!;
}

function canvasButtonOf(row: HTMLElement, title: string): HTMLButtonElement {
  return row.querySelector<HTMLButtonElement>(
    `button[aria-label="Show ${title} on the canvas"]`,
  )!;
}

function replyButtonOf(row: HTMLElement): HTMLButtonElement | null {
  return row.querySelector<HTMLButtonElement>(
    '[data-slot="timeline-event-reply"]',
  );
}

function archiveButtonOf(row: HTMLElement): HTMLButtonElement | null {
  return row.querySelector<HTMLButtonElement>(
    '[data-slot="timeline-event-archive"]',
  );
}

describe('TimelinePanel — structure', () => {
  it('is a named region with an ordered list of rows and no filter', () => {
    const el = render();

    expect(el.tagName).toBe('SECTION');
    expect(el.getAttribute('aria-label')).toBe('Timeline');
    expect(el.querySelector('[data-slot="timeline-filter"]')).toBeNull();
    expect(el.querySelector('[data-slot="segmented-control"]')).toBeNull();
    const days = el.querySelectorAll('[data-slot="timeline-days"] > li');
    expect(days.length).toBe(4);
    for (const row of el.querySelectorAll('[data-slot="timeline-event"]')) {
      expect(row.tagName).toBe('LI');
      expect(row.parentElement!.tagName).toBe('OL');
    }
  });

  it('draws one row for every event, with its kind', () => {
    const el = render();

    expect(shownKinds(el)).toHaveLength(timelineFixtures().length);
    expect(new Set(shownKinds(el))).toEqual(
      new Set([
        'user_message',
        'manager_message',
        'thread_message',
        'thread_started',
        'start_requested',
        'pull_request',
        'question',
        'approval',
        'stage',
        'outcome',
        'failed',
      ]),
    );
  });
});

describe('TimelinePanel — days', () => {
  it('groups the events under Today, Yesterday and the short date of older ones, newest first', () => {
    const el = render();

    const headings = [
      ...el.querySelectorAll('[data-slot="timeline-days"] h3'),
    ].map((h) => h.textContent);
    const shortDate = (day: string): string =>
      new Date(`${day}T12:00:00`).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
      });
    expect(headings).toEqual([
      'Today',
      'Yesterday',
      shortDate('2026-11-13'),
      shortDate('2026-11-12'),
    ]);
    const today = el.querySelectorAll(
      '[data-slot="timeline-days"] > li:first-child [data-slot="timeline-event"]',
    );
    expect(today).toHaveLength(8);
  });

  it('shows each event time as HH:mm', () => {
    const el = render();

    expect(
      rowOf(el, 'manager_message').querySelector('time')!.textContent,
    ).toBe('11:58');
    expect(
      rowOf(el, 'manager_message')
        .querySelector('time')!
        .getAttribute('datetime'),
    ).toBe(new Date('2026-11-17T11:58:00').toISOString());
  });
});

describe('TimelinePanel — empty', () => {
  it('says nothing is here when there is no event', () => {
    const el = render({ events: [], hasMore: false });

    expect(shownKinds(el)).toEqual([]);
    expect(el.textContent).toContain('Nothing here yet');
  });
});

describe('TimelinePanel — threads and messages', () => {
  it('shows the thread of a row on the canvas when the row is pressed', () => {
    const onShowThread = vi.fn();
    const el = render({ onShowThread });

    press(canvasButtonOf(rowOf(el, 'pull_request'), 'Fix the login redirect'));

    expect(onShowThread).toHaveBeenCalledTimes(1);
    expect(onShowThread).toHaveBeenCalledWith('run-login');
  });

  it('names the pull request by its number', () => {
    const el = render();

    expect(rowOf(el, 'pull_request').textContent).toContain('opened PR #418');
  });

  it('gives a user message no button, only the words You wrote', () => {
    const el = render();

    const row = rowOf(el, 'user_message');
    expect(row.querySelector('button')).toBeNull();
    expect(row.textContent).toContain('You wrote');
  });

  it('shows a thread row without a thread as plain text, with no button', () => {
    const el = render({
      events: [
        {
          id: 'evt-x',
          at: new Date('2026-11-17T08:15:00').toISOString(),
          kind: 'start_requested',
          threadRunId: null,
          threadTitle: 'Wire the thread-start conductor',
          text: null,
          detail: null,
          awaitingReply: false,
        },
      ],
    });

    const row = rowOf(el, 'start_requested');
    expect(row.querySelector('button')).toBeNull();
    expect(row.textContent).toContain('Wire the thread-start conductor');
    expect(row.textContent).toContain('Start requested');
  });

  it('marks a manager message awaiting a reply, and only that one', () => {
    const el = render();

    expect(
      rowOf(el, 'manager_message').querySelector('[data-slot="badge"]')!
        .textContent,
    ).toBe('awaiting reply');
    expect(rowOf(el, 'question').textContent).not.toContain('awaiting reply');
    expect(rowOf(el, 'thread_message').textContent).not.toContain(
      'awaiting reply',
    );
  });

  it('colours an outcome that failed as a failure, and a finished one as a success', () => {
    const el = render();

    const outcomes = [
      ...el.querySelectorAll<HTMLElement>('[data-kind="outcome"]'),
    ];
    expect(outcomes).toHaveLength(2);
    const finished = outcomes.find((row) => row.textContent.includes('done'))!;
    const failed = outcomes.find((row) => row.textContent.includes('failed'))!;
    expect(
      finished.querySelector('span[aria-hidden="true"]')!.className,
    ).toContain('text-success');
    expect(
      failed.querySelector('span[aria-hidden="true"]')!.className,
    ).toContain('text-destructive');
  });

  it('draws no link, and each button in the panel is one of its own actions', () => {
    const onShowThread = vi.fn();
    const onReply = vi.fn<TimelinePanelProps['onReply']>();
    const onLoadOlder = vi.fn();
    const archive = vi.fn();
    const el = render(
      {
        events: [
          eventOf('question', 'item-q1', BILLING),
          eventOf('outcome', 'board-run', {
            ...RELEASE,
            detail: 'done',
          }),
        ],
        onShowThread,
        onReply,
        onLoadOlder,
        openItemIds: new Set(['item-q1']),
      },
      () => archive,
    );

    expect(el.querySelectorAll('a, [href], [role="link"]')).toHaveLength(0);
    const buttons = [...el.querySelectorAll<HTMLButtonElement>('button')];
    for (const button of buttons) {
      press(button);
    }

    expect(onShowThread).toHaveBeenCalledTimes(2);
    expect(onReply).toHaveBeenCalledTimes(1);
    expect(archive).toHaveBeenCalledTimes(1);
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });
});

describe('TimelinePanel — answering from the timeline', () => {
  it('draws Reply only on a question or an approval its thread still waits on', () => {
    const el = render({
      events: [
        eventOf('question', 'item-q1', BILLING),
        eventOf('question', 'item-q2', BILLING),
        eventOf('approval', 'item-a1', BILLING),
        eventOf('thread_message', 'item-q1', BILLING),
      ],
      openItemIds: new Set(['item-q1', 'item-a1']),
    });

    const [asked, answered] = rowsOf(el, 'question');
    expect(replyButtonOf(asked!)).not.toBeNull();
    expect(replyButtonOf(answered!)).toBeNull();
    expect(replyButtonOf(rowOf(el, 'approval'))).not.toBeNull();
    expect(replyButtonOf(rowOf(el, 'thread_message'))).toBeNull();
  });

  it('hands the popover the pressed button and the thread title, and shows no thread', () => {
    const onReply = vi.fn<TimelinePanelProps['onReply']>();
    const onShowThread = vi.fn();
    const el = render({
      events: [eventOf('question', 'item-q1', BILLING)],
      openItemIds: new Set(['item-q1']),
      onReply,
      onShowThread,
    });
    const button = replyButtonOf(rowOf(el, 'question'))!;

    expect(button.getAttribute('aria-label')).toBe('Reply to Billing export');
    press(button);

    expect(onReply).toHaveBeenCalledTimes(1);
    const [runId, anchor, title] = onReply.mock.calls[0]!;
    expect(runId).toBe('run-billing');
    expect(anchor).toBe(button);
    expect(title).toBe('Billing export');
    expect(onShowThread).not.toHaveBeenCalled();
  });
});

describe('TimelinePanel — archiving a finished thread', () => {
  it('draws Archive on a finished thread the archive context offers, and on no other row', () => {
    const el = render(
      {
        events: [
          eventOf('outcome', 'board-run', {
            threadRunId: 'board-run',
            threadTitle: 'Release notes',
            detail: 'done',
          }),
          eventOf('outcome', 'off-board', {
            threadRunId: 'off-board',
            threadTitle: 'Billing export',
            detail: 'done',
          }),
          eventOf('pull_request', 'board-run', {
            threadRunId: 'board-run',
            threadTitle: 'Release notes',
            detail: '418',
          }),
        ],
      },
      (runId) => (runId === 'board-run' ? vi.fn() : null),
    );

    const [onBoard, offBoard] = rowsOf(el, 'outcome');
    expect(archiveButtonOf(onBoard!)).not.toBeNull();
    expect(archiveButtonOf(offBoard!)).toBeNull();
    expect(archiveButtonOf(rowOf(el, 'pull_request'))).toBeNull();
  });

  it('draws no Archive where no archive context stands', () => {
    const el = render({
      events: [
        eventOf('outcome', 'board-run', {
          threadRunId: 'board-run',
          threadTitle: 'Release notes',
          detail: 'done',
        }),
      ],
    });

    expect(el.querySelector('[data-slot="timeline-event-archive"]')).toBeNull();
  });

  it('archives the thread when its Archive is pressed, and shows no thread', () => {
    const archive = vi.fn();
    const onShowThread = vi.fn();
    const el = render(
      {
        events: [
          eventOf('outcome', 'board-run', {
            threadRunId: 'board-run',
            threadTitle: 'Release notes',
            detail: 'done',
          }),
        ],
        onShowThread,
      },
      () => archive,
    );

    press(archiveButtonOf(rowOf(el, 'outcome'))!);

    expect(archive).toHaveBeenCalledTimes(1);
    expect(onShowThread).not.toHaveBeenCalled();
  });
});

describe('isAnswerable', () => {
  const open = new Set(['item-q1', 'item-a1']);

  it('is true for a question or an approval whose item the thread still waits on', () => {
    expect(isAnswerable(eventOf('question', 'item-q1'), open)).toBe(true);
    expect(isAnswerable(eventOf('approval', 'item-a1'), open)).toBe(true);
  });

  it('is false for a question the thread no longer waits on', () => {
    expect(isAnswerable(eventOf('question', 'item-q2'), open)).toBe(false);
  });

  it('is false for any other kind, even when its item is one the thread waits on', () => {
    expect(isAnswerable(eventOf('thread_message', 'item-q1'), open)).toBe(
      false,
    );
    expect(isAnswerable(eventOf('outcome', 'item-a1'), open)).toBe(false);
  });
});

describe('TimelinePanel — loading and errors', () => {
  it('asks for older events from Load older', () => {
    const onLoadOlder = vi.fn();
    const el = render({ onLoadOlder });

    act(() => {
      el.querySelector<HTMLButtonElement>(
        '[data-slot="timeline-load-older"]',
      )!.click();
    });

    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });

  it('draws no Load older when nothing older is there', () => {
    const el = render({ hasMore: false });

    expect(el.querySelector('[data-slot="timeline-load-older"]')).toBeNull();
  });

  it('holds Load older while older events are on their way', () => {
    const el = render({ loading: true });

    const button = el.querySelector<HTMLButtonElement>(
      '[data-slot="timeline-load-older"]',
    )!;
    expect(button.disabled).toBe(true);
    expect(button.querySelector('svg')).not.toBeNull();
  });

  it('says it is loading, and nothing else, before any event has arrived', () => {
    const el = render({ events: [], loading: true, hasMore: false });

    expect(el.textContent).toContain('Loading the timeline');
    expect(el.textContent).not.toContain('Nothing here yet');
    expect(el.querySelector('[data-slot="timeline-days"]')).toBeNull();
  });

  it('shows an empty timeline as nothing here yet', () => {
    const el = render({ events: [], hasMore: false });

    expect(el.textContent).toContain('Nothing here yet');
    expect(el.querySelector('[data-slot="timeline-event"]')).toBeNull();
  });

  it('shows a load error in words, and does not claim the timeline is empty', () => {
    const el = render({
      events: [],
      hasMore: false,
      error: 'Could not load the timeline.',
    });

    const alert = el.querySelector<HTMLElement>('[role="alert"]')!;
    expect(alert.textContent).toBe('Could not load the timeline.');
    expect(el.textContent).not.toContain('Nothing here yet');
  });

  it('keeps the events it has when an older page fails', () => {
    const el = render({ error: 'Could not load older events.' });

    expect(el.querySelector('[role="alert"]')!.textContent).toBe(
      'Could not load older events.',
    );
    expect(shownKinds(el)).toHaveLength(timelineFixtures().length);
  });
});
