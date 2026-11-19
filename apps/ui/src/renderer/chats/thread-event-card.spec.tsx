// @vitest-environment jsdom
import { act } from 'react';
import { describe, expect, it } from 'vitest';

import { mountIntoDocument } from '../__tests__/mount-into-document';
import { ThreadEventCard, ThreadEventRow } from './thread-event-card';
import {
  type ThreadIdentity,
  ThreadIdentityContext,
  ThreadOpenContext,
} from './thread-title';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const render = mountIntoDocument();

const PELICAN: ThreadIdentity = {
  title: 'Pelican — fix the login redirect',
  project: 'Web',
  projectColor: 'teal',
  agentLabel: 'claude',
  isTeam: false,
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
  it('heads a known thread as the canvas does: its title, agent and project in the project colour', () => {
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
    expect(article.className).toContain('border-l-group-teal');
    expect(article.dataset.color).toBe('teal');
    expect(article.textContent).toContain('Pelican — fix the login redirect');
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

  it('draws a thread the view does not know neutrally, under the title the row recorded', () => {
    const el = render(
      <ThreadEventCard kind="received" runId="r-otter" title="Otter" />,
    );
    const article = card(el);
    expect(article.className).not.toContain('border-l-group-');
    expect(article.dataset.color).toBeUndefined();
    expect(article.textContent).toContain('Otter');
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
        '[data-slot="thread-title"]',
      )?.click();
    });
    expect(opened).toEqual(['r-otter']);
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
