// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ThreadArchiveContext,
  type ThreadArchiveOf,
} from '../components/thread-archive';
import type { ThreadAttention } from '../components/thread-labels';
import {
  ThreadCard,
  threadCardHeight,
  type ThreadCardProps,
  type ThreadCardStatus,
} from './thread-card';

const NOW = Date.parse('2026-11-17T12:00:00Z');

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

function props(over: Partial<ThreadCardProps> = {}): ThreadCardProps {
  return {
    title: 'Fix the login redirect',
    status: 'working',
    statusText: 'Working',
    attention: 'working',
    project: 'Geniro',
    agentLabel: 'claude',
    isTeam: false,
    face: { kind: 'unknown' },
    pullRequest: null,
    note: null,
    lastMessage: null,
    boardCard: null,
    idleDays: null,
    lastAt: new Date(NOW - 5 * 60_000).toISOString(),
    now: NOW,
    onOpenInChats: vi.fn(),
    ...over,
  };
}

function render(
  over: Partial<ThreadCardProps> = {},
  archiveOf: ThreadArchiveOf | null = null,
): HTMLElement {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <ThreadArchiveContext.Provider value={archiveOf}>
        <ThreadCard {...props(over)} />
      </ThreadArchiveContext.Provider>,
    );
  });
  return container.querySelector<HTMLElement>('[data-slot="thread-card"]')!;
}

describe('ThreadCard — the head', () => {
  it('heads the card with the thread head, its face and its title', () => {
    const el = render();

    expect(el.querySelector('[data-slot="thread-card-head"]')).not.toBeNull();
    expect(
      el
        .querySelector('[data-slot="thread-card-face"]')!
        .getAttribute('data-face'),
    ).toBe('unknown');
    expect(
      el.querySelector('[data-slot="thread-card-title"]')!.textContent,
    ).toBe('Fix the login redirect');
  });

  it('keeps the Show chat, Archive and Open in Chats icons in the footer, off the title line', () => {
    const el = render(
      { runId: 'run-1', onToggleCard: vi.fn() },
      vi.fn<ThreadArchiveOf>(() => vi.fn()),
    );
    const head = el.querySelector('[data-slot="thread-card-head"]')!;
    const actions = el.querySelector('[data-slot="thread-card-actions"]')!;

    for (const slot of [
      'thread-head-show-chat',
      'thread-head-archive',
      'thread-head-open-in-chats',
    ]) {
      expect(head.querySelector(`[data-slot="${slot}"]`)).toBeNull();
      expect(actions.querySelector(`[data-slot="${slot}"]`)).not.toBeNull();
    }
  });

  it('opens nothing when the card itself is clicked', () => {
    const onToggleCard = vi.fn();
    const onOpenInChats = vi.fn();
    const el = render({ onToggleCard, onOpenInChats });

    act(() => {
      el.click();
    });

    expect(onToggleCard).not.toHaveBeenCalled();
    expect(onOpenInChats).not.toHaveBeenCalled();
    expect(el.getAttribute('role')).toBeNull();
  });

  it('turns the card into its chat from the title and from the Show chat icon', () => {
    const onToggleCard = vi.fn();
    const el = render({ onToggleCard });

    const title = el.querySelector<HTMLButtonElement>(
      '[data-slot="thread-card-title"]',
    )!;
    expect(title.tagName).toBe('BUTTON');
    act(() => {
      title.click();
    });
    expect(onToggleCard).toHaveBeenCalledTimes(1);

    const showChat = el.querySelector<HTMLButtonElement>(
      '[data-slot="thread-head-show-chat"]',
    )!;
    expect(showChat.getAttribute('aria-label')).toBe(
      'Show the chat of Fix the login redirect',
    );
    act(() => {
      showChat.click();
    });
    expect(onToggleCard).toHaveBeenCalledTimes(2);
  });

  it('takes the thread to Chats only from its Open in Chats icon', () => {
    const onToggleCard = vi.fn();
    const onOpenInChats = vi.fn();
    const el = render({ onToggleCard, onOpenInChats });

    act(() => {
      el.querySelector<HTMLButtonElement>(
        '[data-slot="thread-head-open-in-chats"]',
      )!.click();
    });

    expect(onOpenInChats).toHaveBeenCalledTimes(1);
    expect(onToggleCard).not.toHaveBeenCalled();
  });

  it('draws neither a Show chat icon nor a title button without a card to toggle', () => {
    const el = render({ onToggleCard: undefined });

    expect(el.querySelector('[data-slot="thread-head-show-chat"]')).toBeNull();
    expect(el.querySelector('[data-slot="thread-card-title"]')!.tagName).toBe(
      'SPAN',
    );
    expect(
      el.querySelector('[data-slot="thread-head-open-in-chats"]'),
    ).not.toBeNull();
  });

  it('wears a team run’s member faces, and one agent’s glyph for one agent', () => {
    const team = render({
      isTeam: true,
      agentLabel: 'dev-team',
      face: {
        kind: 'team',
        people: [
          { key: 'a', name: 'Nick Fury', avatar: null },
          { key: 'b', name: 'Tony Stark', avatar: null },
        ],
        total: 6,
      },
    });
    const face = team.querySelector<HTMLElement>(
      '[data-slot="thread-card-face"]',
    )!;

    expect(face.getAttribute('data-face')).toBe('team');
    expect(face.getAttribute('aria-label')).toBe('6 members');
    expect(face.querySelectorAll('[data-slot="avatar"]')).toHaveLength(2);
    expect(
      face.querySelector('[data-slot="avatar-stack-rest"]')!.textContent,
    ).toBe('+4');

    const agent = render({
      face: { kind: 'agent', icon: 'bot', name: 'Claude' },
    });
    expect(
      agent
        .querySelector('[data-slot="thread-card-face"]')!
        .getAttribute('data-face'),
    ).toBe('agent');
  });
});

describe('ThreadCard — project colour', () => {
  it('wears its project’s colour as a dot on the project label, in the glyph’s place', () => {
    const label = render({
      project: 'Geniro',
      projectColor: 'teal',
    }).querySelector<HTMLElement>('[data-slot="thread-card-project"]')!;

    const dot = label.querySelector<HTMLElement>(
      '[data-slot="thread-card-project-dot"]',
    )!;
    expect(dot.dataset.color).toBe('teal');
    expect(label.querySelector('svg')).toBeNull();
    expect(label.getAttribute('title')).toBe('Project Geniro');
  });

  it('wears its project’s colour as a stripe along its top, and no stripe without a coloured project', () => {
    const stripe = render({
      project: 'Geniro',
      projectColor: 'teal',
    }).querySelector<HTMLElement>('[data-slot="thread-card-project-stripe"]')!;
    expect(stripe.dataset.color).toBe('teal');
    expect(stripe.classList.contains('bg-group-teal')).toBe(true);

    expect(
      render({ project: 'Geniro', projectColor: null }).querySelector(
        '[data-slot="thread-card-project-stripe"]',
      ),
    ).toBeNull();
  });

  it('keeps the folder glyph and no dot when the project has no colour, and draws no label without a project', () => {
    const plain = render({ project: 'Geniro', projectColor: null });
    expect(
      plain.querySelector('[data-slot="thread-card-project-dot"]'),
    ).toBeNull();
    expect(
      plain.querySelector('[data-slot="thread-card-project"] svg'),
    ).not.toBeNull();

    const none = render({ project: null, projectColor: null });
    expect(none.querySelector('[data-slot="thread-card-project"]')).toBeNull();
    expect(
      none.querySelector('[data-slot="thread-card-project-dot"]'),
    ).toBeNull();
  });
});

describe('ThreadCard — content', () => {
  it.each<[ThreadCardStatus, string]>([
    ['working', 'Working'],
    ['waiting', 'Awaiting reply'],
    ['idle', 'Idle'],
    ['failed', 'Needs approval'],
    ['done', 'Done'],
  ])(
    'puts the words it is given for the %s status on its chip',
    (status, text) => {
      const el = render({ status, statusText: text });

      const line = el.querySelector<HTMLElement>(
        '[data-slot="thread-card-status"]',
      )!;
      expect(line.textContent).toContain(text);
      expect(el.dataset.status).toBe(status);
    },
  );

  it.each<[ThreadAttention, string]>([
    ['blocked', 'bg-destructive/5'],
    ['working', 'bg-success/5'],
    ['question', 'bg-warning/10'],
    ['quiet', 'bg-card'],
    ['inactive', 'opacity-70'],
    ['done', 'bg-muted/40'],
  ])('colours a %s card by where it stands', (attention, tint) => {
    const el = render({ attention });

    expect(el.dataset.attention).toBe(attention);
    expect(el.classList.contains(tint)).toBe(true);
  });

  it('folds a long title onto two lines rather than cutting it to one, whole in its tooltip', () => {
    const long = 'A long thread title '.repeat(12).trim();
    const el = render({ title: long });

    const title = el.querySelector<HTMLElement>(
      '[data-slot="thread-card-title"]',
    )!;
    expect(title.classList.contains('line-clamp-2')).toBe(true);
    expect(title.classList.contains('truncate')).toBe(false);
    expect(title.title).toBe(long);
  });

  it('runs its labels onto further lines rather than cutting them at the card’s edge', () => {
    const labels = render({
      agentLabel: 'claude',
      boardCard: {
        identifier: 'GEN-412',
        title: 'Fix login',
        status: 'in_progress',
      },
      project: 'Geniro',
    }).querySelector<HTMLElement>('[data-slot="thread-card-labels"]')!;

    expect(labels.classList.contains('flex-wrap')).toBe(true);
    expect(labels.classList.contains('overflow-hidden')).toBe(false);
  });

  it('grows with what it shows, never shorter than the height the graph first lays it out at', () => {
    const view = { note: 'watch billing', lastMessage: 'running tests' };
    const el = render({ ...view, idleDays: 4 });

    expect(el.style.height).toBe('');
    expect(el.style.minHeight).toBe(`${threadCardHeight(view)}px`);
    const bare = threadCardHeight({ note: null, lastMessage: null });
    const oneLine = threadCardHeight({ note: null, lastMessage: 'short' });
    const twoLines = threadCardHeight({
      note: null,
      lastMessage:
        'a longer message that cannot fit on a single line of the card',
    });
    expect(bare).toBeLessThan(oneLine);
    expect(oneLine).toBeLessThan(twoLines);
  });

  it('draws the manager note when there is one, and nothing when there is not', () => {
    const withNote = render({ note: 'Waiting for the CI run' });
    expect(
      withNote.querySelector('[data-slot="thread-card-note"]')!.textContent,
    ).toBe('Waiting for the CI run');

    const without = render({ note: null });
    expect(without.querySelector('[data-slot="thread-card-note"]')).toBeNull();
  });

  it('shows the pull request with its number and state word', () => {
    const el = render({ pullRequest: { number: 412, state: 'merged' } });

    const chip = el.querySelector<HTMLElement>(
      '[data-slot="thread-card-pull-request"]',
    )!;
    expect(chip.textContent).toContain('412');
    expect(chip.textContent).toContain('merged');
  });

  it('draws no pull request chip when the thread has none', () => {
    const el = render({ pullRequest: null });

    expect(
      el.querySelector('[data-slot="thread-card-pull-request"]'),
    ).toBeNull();
  });

  it('labels the agent, or the team by its name, and the project — never the roster handle', () => {
    const el = render({ agentLabel: 'claude', project: 'Geniro' });

    expect(
      el.querySelector('[data-slot="thread-card-agent"]')!.textContent,
    ).toBe('claude');
    expect(
      el.querySelector('[data-slot="thread-card-project"]')!.textContent,
    ).toBe('Geniro');
    expect(el.textContent).not.toMatch(/\bt\d+\b/);
    expect(
      render({ agentLabel: 'dev-team', isTeam: true })
        .querySelector('[data-slot="thread-card-agent"]')!
        .getAttribute('title'),
    ).toBe('Team dev-team');
  });

  it('previews the latest message as the thread list does, when there is one', () => {
    expect(
      render({ lastMessage: 'running the test suite' }).querySelector(
        '[data-slot="thread-card-message"]',
      )!.textContent,
    ).toBe('running the test suite');
    expect(
      render({ lastMessage: null }).querySelector(
        '[data-slot="thread-card-message"]',
      ),
    ).toBeNull();
  });

  it('previews it as plain text, with no markdown markers', () => {
    const line = render({
      lastMessage: '**Rebased** on `main` — see [the PR](https://x.test/1)',
    }).querySelector('[data-slot="thread-card-message"]')!;

    expect(line.textContent).toBe('Rebased on main — see the PR');
  });

  it('drops a backtick a cut-off code span left open', () => {
    const line = render({
      lastMessage: 'Told `8bbdf9e6-0a39-4d4d-a…',
    }).querySelector('[data-slot="thread-card-message"]')!;

    expect(line.textContent).toBe('Told 8bbdf9e6-0a39-4d4d-a…');
  });

  it('says when the thread last moved', () => {
    expect(
      render().querySelector('[data-slot="thread-card-time"]')!.textContent,
    ).toBe('5m');
  });

  it('dates a thread older than a week the way the thread list does', () => {
    expect(
      render({ lastAt: '2026-11-02T12:00:00Z', idleDays: 15 }).querySelector(
        '[data-slot="thread-card-time"]',
      )!.textContent,
    ).toBe('Nov 2');
  });

  it('stands as tall as its row asks, but never shorter than its content', () => {
    const own = threadCardHeight({ note: null, lastMessage: null });

    expect(render({ height: own + 40 }).style.minHeight).toBe(`${own + 40}px`);
    expect(render({ height: own - 40 }).style.minHeight).toBe(`${own}px`);
  });

  it('draws no timeline strip', () => {
    expect(render().querySelector('[data-slot="timeline-strip"]')).toBeNull();
  });
});

describe('ThreadCard — labels', () => {
  it('shows the board card it works as a label, and none for a thread without one', () => {
    const label = render({
      boardCard: {
        identifier: 'GEN-412',
        title: 'Fix login',
        status: 'in_progress',
      },
    }).querySelector('[data-slot="thread-card-board-card"]')!;

    expect(label.textContent).toBe('GEN-412');
    expect(label.getAttribute('title')).toContain('In progress');
    expect(
      render({ boardCard: null }).querySelector(
        '[data-slot="thread-card-board-card"]',
      ),
    ).toBeNull();
  });

  it('marks a thread nobody touched for days with a moon by its time, and only such a thread', () => {
    expect(
      render({ idleDays: 6 })
        .querySelector('[data-slot="thread-card-idle"]')!
        .getAttribute('aria-label'),
    ).toBe('Nobody has touched this thread for 6 days');
    expect(
      render({ idleDays: null }).querySelector(
        '[data-slot="thread-card-idle"]',
      ),
    ).toBeNull();
  });
});

describe('ThreadCard — motion', () => {
  it('runs a border around a working card, and breathes in warning while it waits on the user', () => {
    const working = render({ attention: 'working' });
    expect(working.classList.contains('cc-running-border')).toBe(true);
    expect(working.classList.contains('cc-breathe-success')).toBe(false);
    const asking = render({ attention: 'question', onAnswer: vi.fn() });
    expect(asking.classList.contains('cc-breathe-warning')).toBe(true);
    expect(asking.classList.contains('cc-running-border')).toBe(false);
  });

  it.each<ThreadAttention>([
    'blocked',
    'question',
    'quiet',
    'inactive',
    'done',
  ])('gives a %s card neither the running border nor a breath', (attention) => {
    const el = render({ attention });
    expect(el.classList.contains('cc-running-border')).toBe(false);
    expect(el.className.includes('cc-breathe')).toBe(false);
  });
});

describe('ThreadCard — archive', () => {
  it('archives from the footer icon of any thread the provider offers one for', () => {
    const archive = vi.fn();
    const archiveOf = vi.fn<ThreadArchiveOf>(() => archive);
    const el = render({ runId: 'run-1', attention: 'working' }, archiveOf);

    act(() => {
      el.querySelector<HTMLButtonElement>(
        '[data-slot="thread-head-archive"]',
      )!.click();
    });

    expect(archiveOf).toHaveBeenCalledWith('run-1');
    expect(archive).toHaveBeenCalledTimes(1);
  });

  it('offers the footer Archive only on a finished thread, and it archives the same thread', () => {
    const archive = vi.fn();
    const finished = render(
      { runId: 'run-1', attention: 'done' },
      () => archive,
    );

    expect(
      finished.querySelector('[data-slot="thread-head-archive"]'),
    ).not.toBeNull();
    act(() => {
      finished
        .querySelector<HTMLButtonElement>('[data-slot="thread-card-archive"]')!
        .click();
    });
    expect(archive).toHaveBeenCalledTimes(1);

    const working = render(
      { runId: 'run-1', attention: 'quiet' },
      () => archive,
    );
    expect(
      working.querySelector('[data-slot="thread-card-archive"]'),
    ).toBeNull();
  });

  it('draws no archive without a provider standing, even on a finished thread', () => {
    const el = render({ runId: 'run-1', attention: 'done' });

    expect(el.querySelector('[data-slot="thread-head-archive"]')).toBeNull();
    expect(el.querySelector('[data-slot="thread-card-archive"]')).toBeNull();
  });

  it('draws no archive for a thread the provider answers null for', () => {
    const el = render({ runId: 'run-1', attention: 'done' }, () => null);

    expect(el.querySelector('[data-slot="thread-head-archive"]')).toBeNull();
    expect(el.querySelector('[data-slot="thread-card-archive"]')).toBeNull();
  });
});
