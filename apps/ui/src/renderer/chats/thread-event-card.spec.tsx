// @vitest-environment jsdom
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { mountIntoDocument } from '../__tests__/mount-into-document';
import {
  ThreadArchiveContext,
  type ThreadArchiveOf,
} from '../components/thread-archive';
import type { ThreadIdentity } from '../components/thread-head';
import { ThreadEventCard, ThreadEventRow } from './thread-event-card';
import { ThreadIdentityContext, ThreadOpenContext } from './thread-title';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const render = mountIntoDocument();

const PELICAN: ThreadIdentity = {
  title: 'Pelican — fix the login redirect',
  face: { kind: 'agent', icon: 'terminal', name: 'claude' },
  pullRequest: { number: 88, state: 'open' },
  status: { attention: 'working', text: 'Working' },
  agentLabel: 'claude',
  isTeam: false,
  boardCard: { identifier: 'WEB-7', title: 'Login redirect', status: 'todo' },
  project: 'Web',
  projectColor: 'teal',
};

const IDENTITIES = new Map([['r-pelican', PELICAN]]);

function card(el: HTMLElement): HTMLElement {
  const found = el.querySelector<HTMLElement>(
    '[data-slot="thread-event-card"]',
  );
  if (found === null) {
    throw new Error('no thread event card');
  }
  return found;
}

describe('ThreadEventCard', () => {
  it('heads a known thread as its node on the graph does: face, title, pull request, status, agent, board card and project dot', () => {
    const el = render(
      <ThreadIdentityContext.Provider value={IDENTITIES}>
        <ThreadEventCard
          kind="received"
          runId="r-pelican"
          title="Pelican"
          text="hi"
        />
      </ThreadIdentityContext.Provider>,
    );
    const article = card(el);
    expect(article.className).not.toContain('border-l-');
    expect(article.dataset.color).toBe('teal');
    expect(
      el.querySelector('[data-slot="thread-event-title"]')?.textContent,
    ).toBe('Pelican — fix the login redirect');
    expect(
      el.querySelector<HTMLElement>('[data-slot="thread-event-face"]')?.dataset
        .face,
    ).toBe('agent');
    expect(
      el.querySelector('[data-slot="thread-event-status"]')?.textContent,
    ).toBe('Working');
    expect(
      el.querySelector('[data-slot="thread-event-pull-request"]')?.textContent,
    ).toContain(`#${88}`);
    expect(
      el.querySelector('[data-slot="thread-event-board-card"]')?.textContent,
    ).toBe('WEB-7');
    expect(
      el.querySelector('[data-slot="thread-event-agent"]')?.textContent,
    ).toBe('claude');
    expect(
      el.querySelector('[data-slot="thread-event-project"]')?.textContent,
    ).toBe('Web');
    expect(
      el.querySelector<HTMLElement>('[data-slot="thread-event-project-dot"]')
        ?.dataset.color,
    ).toBe('teal');
  });

  it('spans the transcript column rather than stopping short of it', () => {
    const article = card(
      render(
        <ThreadEventCard kind="received" runId="r-x" title="X" text="hi" />,
      ),
    );
    expect(article.classList).toContain('w-full');
    expect(article.className).not.toMatch(/\bmax-w-|\bself-start\b/);
  });

  it('draws a thread the view does not know neutrally, under the title the row recorded', () => {
    const el = render(
      <ThreadEventCard kind="received" runId="r-otter" title="Otter" />,
    );
    const article = card(el);
    expect(article.dataset.color).toBeUndefined();
    expect(
      el.querySelector('[data-slot="thread-event-title"]')?.textContent,
    ).toBe('Otter');
    expect(
      el.querySelector<HTMLElement>('[data-slot="thread-event-face"]')?.dataset
        .face,
    ).toBe('unknown');
    expect(el.querySelector('[data-slot="thread-event-labels"]')).toBeNull();
    expect(el.querySelector('[data-slot="thread-event-agent"]')).toBeNull();
    expect(el.querySelector('[data-slot="thread-event-project"]')).toBeNull();
  });

  it('opens the thread from its title where the view can', () => {
    const opened: string[] = [];
    const el = render(
      <ThreadOpenContext.Provider value={(runId) => opened.push(runId)}>
        <ThreadEventCard kind="sent" runId="r-otter" title="Otter" />
      </ThreadOpenContext.Provider>,
    );
    act(() => {
      el.querySelector<HTMLButtonElement>(
        '[data-slot="thread-event-title"]',
      )?.click();
    });
    expect(opened).toEqual(['r-otter']);
  });

  it('offers Open chat on a finished thread only, opening that thread', () => {
    const opened: string[] = [];
    const done = render(
      <ThreadOpenContext.Provider value={(runId) => opened.push(runId)}>
        <ThreadEventCard kind="done" runId="r-otter" title="Otter" />
      </ThreadOpenContext.Provider>,
    );
    const button = done.querySelector<HTMLButtonElement>(
      '[data-slot="thread-event-open"]',
    );
    expect(button?.textContent).toBe('Open chat');
    act(() => {
      button?.click();
    });
    expect(opened).toEqual(['r-otter']);

    const sent = render(
      <ThreadOpenContext.Provider value={(runId) => opened.push(runId)}>
        <ThreadEventCard kind="sent" runId="r-otter" title="Otter" />
      </ThreadOpenContext.Provider>,
    );
    expect(sent.querySelector('[data-slot="thread-event-open"]')).toBeNull();
  });

  it('draws no Open chat where the view cannot open a thread', () => {
    const el = render(
      <ThreadEventCard kind="done" runId="r-otter" title="Otter" />,
    );

    expect(el.querySelector('[data-slot="thread-event-open"]')).toBeNull();
  });

  it('labels each kind by what happened', () => {
    const labels = (['sent', 'received', 'woken', 'done'] as const).map(
      (kind) => {
        const el = render(
          <ThreadEventCard kind={kind} runId="r-otter" title="Otter" />,
        );
        return el.querySelector('[data-slot="thread-event-label"]')
          ?.textContent;
      },
    );
    expect(labels).toEqual([
      'Message to',
      'Message from',
      'Woken by a message from',
      'Done',
    ]);
  });

  it('quotes the message a received one answers, labelled, with the whole excerpt as its title', () => {
    const el = render(
      <ThreadEventCard
        kind="received"
        runId="r-otter"
        title="Otter"
        inReplyTo="Can you take the **backfill**?"
        text="Yes, on it."
      />,
    );
    const quote = el.querySelector<HTMLElement>(
      '[data-slot="thread-event-reply-to"]',
    );
    expect(quote?.textContent).toContain('In reply to your message');
    expect(quote?.title).toBe('Can you take the backfill?');
    expect(
      el.querySelector('[data-slot="thread-event-text"]')?.textContent,
    ).toContain('Yes, on it.');
  });
});

describe('ThreadEventRow', () => {
  it('draws each received message as a card of its own', () => {
    const el = render(
      <ThreadEventRow
        row={{
          kind: 'received',
          messages: [
            {
              id: 'm1',
              fromRunId: 'r-pelican',
              fromTitle: 'Pelican',
              fromMember: null,
              text: 'hi there',
              inReplyTo: null,
            },
            {
              id: 'm2',
              fromRunId: 'r-otter',
              fromTitle: 'Otter',
              fromMember: 'Backend Engineer',
              text: 'the migration is in',
              inReplyTo: { text: 'status?', at: '2026-11-06T10:00:00.000Z' },
            },
          ],
        }}
      />,
    );
    const cards = el.querySelectorAll<HTMLElement>(
      '[data-slot="thread-event-card"]',
    );
    expect([...cards].map((c) => c.dataset.run)).toEqual([
      'r-pelican',
      'r-otter',
    ]);
    expect(cards[1]?.textContent).toContain('Backend Engineer');
    expect(
      cards[1]?.querySelector('[data-slot="thread-event-reply-to"]'),
    ).not.toBeNull();
    expect(
      cards[0]?.querySelector('[data-slot="thread-event-reply-to"]'),
    ).toBeNull();
  });

  it('shows a sent message with its text and what became of it', () => {
    const el = render(
      <ThreadEventRow
        row={{
          kind: 'sent',
          sent: {
            toRunId: 'r-otter',
            title: 'Otter',
            outcome: 'waiting',
            reason: 'running_turn',
            text: 'Please rebase on main.',
          },
        }}
      />,
    );
    expect(card(el).dataset.kind).toBe('sent');
    expect(
      el.querySelector('[data-slot="thread-event-text"]')?.textContent,
    ).toContain('Please rebase on main.');
    expect(
      el.querySelector('[data-slot="thread-event-outcome"]')?.textContent,
    ).toBe('Waits for the turn running there to end');
  });

  it('draws a sent row written before the text was kept as the header and outcome alone', () => {
    const el = render(
      <ThreadEventRow
        row={{
          kind: 'sent',
          sent: {
            toRunId: 'r-otter',
            title: 'Otter',
            outcome: 'woken',
            reason: null,
            text: null,
          },
        }}
      />,
    );
    expect(el.querySelector('[data-slot="thread-event-text"]')).toBeNull();
    expect(
      el.querySelector('[data-slot="thread-event-outcome"]')?.textContent,
    ).toBe('Started a turn there');
  });

  it('draws the message as markdown, not as its raw source', () => {
    const el = render(
      <ThreadEventCard
        kind="received"
        runId="r-otter"
        title="Otter"
        text={'Batch is **staged**; run `verify` next.'}
      />,
    );
    const body = el.querySelector('[data-slot="thread-event-text"]')!;
    expect(body.querySelector('strong')?.textContent).toBe('staged');
    expect(body.querySelector('code')?.textContent).toBe('verify');
    expect(body.textContent).not.toContain('**');
  });

  it('folds a long message behind Show more, and Show more unfolds it', () => {
    const long = Array.from({ length: 30 }, (_, i) => `- step ${i + 1}`).join(
      '\n',
    );
    const el = render(
      <ThreadEventCard
        kind="received"
        runId="r-otter"
        title="Otter"
        text={long}
      />,
    );
    const body = el.querySelector<HTMLElement>(
      '[data-slot="thread-event-text"]',
    )!;
    expect(body.dataset.clamped).toBe('true');
    const toggle = el.querySelector<HTMLButtonElement>(
      '[data-slot="thread-event-text-toggle"]',
    )!;
    expect(toggle.textContent).toContain('Show more');

    act(() => toggle.click());

    expect(body.dataset.clamped).toBeUndefined();
    expect(toggle.textContent).toContain('Show less');
    expect(body.textContent).toContain('step 30');
  });

  it('shows a short message with a picture whole, with no Show more', () => {
    const el = render(
      <ThreadEventCard
        kind="received"
        runId="r-otter"
        title="Otter"
        text={'Coverage:\n\n![Coverage by module](/tmp/coverage.png)'}
      />,
    );
    const body = el.querySelector<HTMLElement>(
      '[data-slot="thread-event-text"]',
    )!;
    expect(body.dataset.clamped).toBeUndefined();
    expect(
      el.querySelector('[data-slot="thread-event-text-toggle"]'),
    ).toBeNull();
    expect(body.querySelector('[data-slot^="markdown-image"]')).not.toBeNull();
    expect(body.textContent).not.toContain('![');
  });

  it('shows a finished thread with its handle, pull request and what it reported', () => {
    const el = render(
      <ThreadEventRow
        row={{
          kind: 'done',
          done: [
            {
              runId: 'r-otter',
              title: 'Otter',
              handle: 't22',
              summary: 'PRI-10 cancelled; PR #146 closed.',
              pullRequest: 146,
            },
            {
              runId: 'r-elves',
              title: 'Elves',
              handle: 't23',
              summary: null,
              pullRequest: null,
            },
          ],
        }}
      />,
    );
    expect(card(el).dataset.kind).toBe('done');
    expect(
      el.querySelector('[data-slot="thread-event-handle"]')?.textContent,
    ).toBe('t22');
    expect(
      el.querySelector('[data-slot="thread-event-pull-request"]')?.textContent,
    ).toBe(`#${146}`);
    expect(
      el.querySelector('[data-slot="thread-event-text"]')?.textContent,
    ).toContain('PRI-10 cancelled');
  });

  it('draws one card for each thread a batched done row names', () => {
    const el = render(
      <ThreadEventRow
        row={{
          kind: 'done',
          done: [
            {
              runId: 'r-otter',
              title: 'Otter',
              handle: 't22',
              summary: null,
              pullRequest: null,
            },
            {
              runId: 'r-elves',
              title: 'Elves',
              handle: 't23',
              summary: null,
              pullRequest: null,
            },
          ],
        }}
      />,
    );
    const cards = el.querySelectorAll<HTMLElement>(
      '[data-slot="thread-event-card"]',
    );
    expect([...cards].map((c) => c.dataset.run)).toEqual([
      'r-otter',
      'r-elves',
    ]);
  });
});

describe('ThreadEventCard — archive', () => {
  it.each(['sent', 'received', 'woken', 'done'] as const)(
    'heads a %s event with the archive icon of its thread, once the provider offers one',
    (kind) => {
      const el = render(
        <ThreadArchiveContext.Provider value={() => vi.fn()}>
          <ThreadEventCard kind={kind} runId="r-otter" title="Otter" />
        </ThreadArchiveContext.Provider>,
      );

      expect(
        el.querySelector('[data-slot="thread-head-archive"]'),
      ).not.toBeNull();
    },
  );

  it('draws the Archive button on a finished thread only, and archives its thread from it', () => {
    const archive = vi.fn();
    const archiveOf = vi.fn<ThreadArchiveOf>(() => archive);
    const done = render(
      <ThreadArchiveContext.Provider value={archiveOf}>
        <ThreadEventCard kind="done" runId="r-otter" title="Otter" />
      </ThreadArchiveContext.Provider>,
    );

    act(() => {
      done
        .querySelector<HTMLButtonElement>('[data-slot="thread-event-archive"]')!
        .click();
    });

    expect(archiveOf).toHaveBeenCalledWith('r-otter');
    expect(archive).toHaveBeenCalledTimes(1);

    const sent = render(
      <ThreadArchiveContext.Provider value={archiveOf}>
        <ThreadEventCard kind="sent" runId="r-otter" title="Otter" />
      </ThreadArchiveContext.Provider>,
    );
    expect(sent.querySelector('[data-slot="thread-event-archive"]')).toBeNull();
  });

  it('archives its thread from the head icon of any event', () => {
    const archive = vi.fn();
    const el = render(
      <ThreadArchiveContext.Provider value={() => archive}>
        <ThreadEventCard kind="received" runId="r-otter" title="Otter" />
      </ThreadArchiveContext.Provider>,
    );

    act(() => {
      el.querySelector<HTMLButtonElement>(
        '[data-slot="thread-head-archive"]',
      )!.click();
    });

    expect(archive).toHaveBeenCalledTimes(1);
  });

  it('draws no archive without a provider standing, even on a finished thread', () => {
    const el = render(
      <ThreadEventCard kind="done" runId="r-otter" title="Otter" />,
    );

    expect(el.querySelector('[data-slot="thread-head-archive"]')).toBeNull();
    expect(el.querySelector('[data-slot="thread-event-archive"]')).toBeNull();
  });

  it('draws no archive for a thread the provider answers null for', () => {
    const el = render(
      <ThreadArchiveContext.Provider value={() => null}>
        <ThreadEventCard kind="done" runId="r-otter" title="Otter" />
      </ThreadArchiveContext.Provider>,
    );

    expect(el.querySelector('[data-slot="thread-head-archive"]')).toBeNull();
    expect(el.querySelector('[data-slot="thread-event-archive"]')).toBeNull();
  });
});
