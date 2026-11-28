// @vitest-environment jsdom
import { act, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { mountIntoDocument } from '../__tests__/mount-into-document';
import {
  ThreadArchiveContext,
  type ThreadArchiveOf,
  ThreadUnarchiveContext,
} from '../components/thread-archive';
import type { ThreadIdentity } from '../components/thread-head';
import {
  type ThreadArchived,
  ThreadArchivedContext,
  type ThreadDoneDismissals,
  ThreadDoneDismissalsContext,
  ThreadDoneNewestContext,
  ThreadReportsContext,
} from './thread-done-context';
import { ThreadEventCard, ThreadEventRow } from './thread-event-card';
import type { ThreadMessageRow } from './thread-message-payload';
import { ThreadIdentityContext, ThreadOpenContext } from './thread-title';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const render = mountIntoDocument();

const PELICAN: ThreadIdentity = {
  title: 'Pelican — fix the login redirect',
  face: { kind: 'agent', icon: 'terminal', name: 'claude' },
  pullRequest: {
    number: 88,
    state: 'open',
    url: 'https://github.com/acme/app/pull/88',
  },
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

  it("opens a finished thread's pull request from its label, at the pull request's own address", () => {
    const el = render(
      <ThreadIdentityContext.Provider value={IDENTITIES}>
        <ThreadEventCard kind="done" runId="r-pelican" title="Pelican" />
      </ThreadIdentityContext.Provider>,
    );

    const link = el.querySelector<HTMLAnchorElement>(
      '[data-slot="thread-event-pull-request-link"]',
    );
    expect(link?.getAttribute('href')).toBe(
      'https://github.com/acme/app/pull/88',
    );
    expect(
      link?.querySelector('[data-slot="thread-event-pull-request"]')
        ?.textContent,
    ).toContain(`#${88}`);
  });

  it('draws a pull request whose address is unknown as a plain label, and none for a thread without one', () => {
    const unknown = render(
      <ThreadEventCard
        kind="done"
        runId="r-otter"
        title="Otter"
        pullRequest={146}
      />,
    );
    expect(
      unknown.querySelector('[data-slot="thread-event-pull-request"]')
        ?.textContent,
    ).toContain(`#${146}`);
    expect(
      unknown.querySelector('[data-slot="thread-event-pull-request-link"]'),
    ).toBeNull();

    const none = render(
      <ThreadEventCard kind="done" runId="r-otter" title="Otter" />,
    );
    expect(
      none.querySelector('[data-slot="thread-event-pull-request"]'),
    ).toBeNull();
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

describe("ThreadEventCard — a finished thread drawn as the graph's card", () => {
  const CREW: ThreadIdentity = {
    ...PELICAN,
    face: {
      kind: 'team',
      total: 4,
      people: [
        { key: 'lead', name: 'Lead' },
        { key: 'senior', name: 'Senior Engineer' },
        { key: 'qa', name: 'QA' },
      ],
    },
    isTeam: true,
    agentLabel: 'Dev Team',
  };

  it("heads it with the node's full head: the title folds onto two lines instead of being cut beside the labels", () => {
    const el = render(
      <ThreadIdentityContext.Provider value={IDENTITIES}>
        <ThreadEventCard kind="done" runId="r-pelican" title="Pelican" />
      </ThreadIdentityContext.Provider>,
    );
    const head = el.querySelector<HTMLElement>(
      '[data-slot="thread-event-head"]',
    )!;
    expect(head.dataset.compact).toBeUndefined();
    const title = el.querySelector('[data-slot="thread-event-title"]')!;
    expect(title.className).toContain('line-clamp-2');
    expect(title.className).not.toContain('truncate');
    expect(
      title.parentElement?.contains(
        el.querySelector('[data-slot="thread-event-project"]'),
      ),
    ).toBe(false);
  });

  it('says Done once, in its event line, with no status chip in its head', () => {
    const finished: ThreadIdentity = {
      ...PELICAN,
      status: { attention: 'done', text: 'Done' },
    };
    const el = render(
      <ThreadIdentityContext.Provider
        value={new Map([['r-pelican', finished]])}>
        <ThreadEventCard kind="done" runId="r-pelican" title="Pelican" />
      </ThreadIdentityContext.Provider>,
    );

    expect(el.querySelector('[data-slot="thread-event-status"]')).toBeNull();
    expect(el.textContent?.match(/Done/g)).toHaveLength(1);
    expect(
      el.querySelector('[data-slot="thread-event-project"]'),
    ).not.toBeNull();
  });

  it('keeps the one-line head on every other event', () => {
    const el = render(
      <ThreadIdentityContext.Provider value={IDENTITIES}>
        <ThreadEventCard kind="received" runId="r-pelican" title="Pelican" />
      </ThreadIdentityContext.Provider>,
    );
    expect(
      el.querySelector<HTMLElement>('[data-slot="thread-event-head"]')?.dataset
        .compact,
    ).toBe('true');
  });

  it("shows a team thread's members' faces, as its node does", () => {
    const el = render(
      <ThreadIdentityContext.Provider value={new Map([['r-crew', CREW]])}>
        <ThreadEventCard kind="done" runId="r-crew" title="Crew" />
      </ThreadIdentityContext.Provider>,
    );
    const face = el.querySelector<HTMLElement>(
      '[data-slot="thread-event-face"]',
    )!;
    expect(face.dataset.face).toBe('team');
    expect(face.dataset.size).toBe('md');
    expect(face.getAttribute('aria-label')).toBe('4 members');
  });

  it('puts the time it finished and its actions in a foot, Archive worded with its icon', () => {
    const el = render(
      <ThreadDoneDismissalsContext.Provider
        value={{ through: new Map(), dismiss: vi.fn() }}>
        <ThreadArchiveContext.Provider value={() => vi.fn()}>
          <ThreadOpenContext.Provider value={vi.fn()}>
            <ThreadIdentityContext.Provider value={IDENTITIES}>
              <ThreadEventCard
                kind="done"
                runId="r-pelican"
                title="Pelican"
                text="Merged."
                at="2026-11-26T09:00:00Z"
                seq={9}
              />
            </ThreadIdentityContext.Provider>
          </ThreadOpenContext.Provider>
        </ThreadArchiveContext.Provider>
      </ThreadDoneDismissalsContext.Provider>,
    );
    const foot = el.querySelector<HTMLElement>(
      '[data-slot="thread-event-foot"]',
    )!;
    expect(
      foot
        .querySelector('[data-slot="thread-event-time"]')
        ?.getAttribute('title'),
    ).toContain('2026');
    const archive = foot.querySelector<HTMLElement>(
      '[data-slot="thread-event-archive"]',
    )!;
    expect(archive.textContent).toBe('Archive');
    expect(archive.querySelector('svg')).not.toBeNull();
    expect(
      foot.querySelector('[data-slot="thread-event-open"]'),
    ).not.toBeNull();
    expect(
      foot.querySelector('[data-slot="thread-event-dismiss"]'),
    ).not.toBeNull();
    expect(el.querySelector('[data-slot="thread-event-actions"]')).toBeNull();
    expect(card(el).lastElementChild).toBe(foot);
  });
});

describe('ThreadEventCard — archive', () => {
  const ARCHIVE_CONTROLS =
    '[data-slot="thread-head-archive"], [data-slot="thread-event-archive"], [data-slot="thread-event-unarchive"]';

  it.each(['sent', 'received', 'woken'] as const)(
    'heads a %s event with the archive icon of its thread as its one archive control',
    (kind) => {
      const el = render(
        <ThreadArchiveContext.Provider value={() => vi.fn()}>
          <ThreadEventCard kind={kind} runId="r-otter" title="Otter" />
        </ThreadArchiveContext.Provider>,
      );

      expect(
        [...el.querySelectorAll<HTMLElement>(ARCHIVE_CONTROLS)].map(
          (control) => control.dataset.slot,
        ),
      ).toEqual(['thread-head-archive']);
    },
  );

  it('offers a finished thread one Archive control, the worded button, and no head icon beside it', () => {
    const el = render(
      <ThreadArchiveContext.Provider value={() => vi.fn()}>
        <ThreadIdentityContext.Provider value={IDENTITIES}>
          <ThreadEventCard kind="done" runId="r-pelican" title="Pelican" />
        </ThreadIdentityContext.Provider>
      </ThreadArchiveContext.Provider>,
    );

    expect(
      [...el.querySelectorAll<HTMLElement>(ARCHIVE_CONTROLS)].map(
        (control) => control.dataset.slot,
      ),
    ).toEqual(['thread-event-archive']);
  });

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

  describe('a finished thread', () => {
    const DONE_ROW = (
      runId: string,
      summary: string | null,
    ): ThreadMessageRow => ({
      kind: 'done',
      done: [
        { runId, title: 'Otter', handle: 't22', summary, pullRequest: null },
      ],
    });

    function press(el: HTMLElement, slot: string): void {
      act(() => {
        el.querySelector<HTMLButtonElement>(`[data-slot="${slot}"]`)!.click();
      });
    }

    it('draws only the entry in the newest row of its thread, and nothing from an older duplicate', () => {
      const newest = new Map([['r-otter', 9]]);
      const old = render(
        <ThreadDoneNewestContext.Provider value={newest}>
          <ThreadEventRow row={DONE_ROW('r-otter', 'old')} seq={3} />
        </ThreadDoneNewestContext.Provider>,
      );
      expect(old.querySelector('[data-slot="thread-event-card"]')).toBeNull();
      expect(old.querySelector('[data-slot="thread-event-stack"]')).toBeNull();

      const latest = render(
        <ThreadDoneNewestContext.Provider value={newest}>
          <ThreadEventRow row={DONE_ROW('r-otter', 'new')} seq={9} />
        </ThreadDoneNewestContext.Provider>,
      );
      expect(card(latest).dataset.run).toBe('r-otter');
    });

    it('shows the live report in place of the frozen summary, and the frozen one without it', () => {
      const live = render(
        <ThreadReportsContext.Provider
          value={new Map([['r-otter', 'Live report from the thread']])}>
          <ThreadEventCard
            kind="done"
            runId="r-otter"
            title="Otter"
            text="Frozen summary"
          />
        </ThreadReportsContext.Provider>,
      );
      const text = live.querySelector(
        '[data-slot="thread-event-text"]',
      )?.textContent;
      expect(text).toContain('Live report from the thread');
      expect(text).not.toContain('Frozen summary');

      const frozen = render(
        <ThreadReportsContext.Provider value={new Map()}>
          <ThreadEventCard
            kind="done"
            runId="r-otter"
            title="Otter"
            text="Frozen summary"
          />
        </ThreadReportsContext.Provider>,
      );
      expect(
        frozen.querySelector('[data-slot="thread-event-text"]')?.textContent,
      ).toContain('Frozen summary');
    });

    function Dismissable({
      initial = new Map(),
      seq,
      newest,
      onDismiss = () => undefined,
    }: {
      initial?: ReadonlyMap<string, number>;
      seq: number;
      newest: ReadonlyMap<string, number>;
      onDismiss?: (runId: string, seq: number) => void;
    }): React.ReactElement {
      const [through, setThrough] = useState(initial);
      const dismissals: ThreadDoneDismissals = {
        through,
        dismiss: (runId, dismissedSeq) => {
          onDismiss(runId, dismissedSeq);
          setThrough(new Map(through).set(runId, dismissedSeq));
        },
      };
      return (
        <ThreadDoneDismissalsContext.Provider value={dismissals}>
          <ThreadDoneNewestContext.Provider value={newest}>
            <ThreadEventRow row={DONE_ROW('r-otter', 'Finished')} seq={seq} />
          </ThreadDoneNewestContext.Provider>
        </ThreadDoneDismissalsContext.Provider>
      );
    }

    it('removes the card on Dismiss, handing the daemon its thread and row, with no fold left behind', () => {
      const dismissed: [string, number][] = [];
      const el = render(
        <Dismissable
          seq={9}
          newest={new Map([['r-otter', 9]])}
          onDismiss={(runId, seq) => dismissed.push([runId, seq])}
        />,
      );
      expect(
        el
          .querySelector('[data-slot="thread-event-dismiss"]')
          ?.getAttribute('title'),
      ).toBe(
        "Remove this card on every device; the thread's next finish brings a new one",
      );

      press(el, 'thread-event-dismiss');

      expect(dismissed).toEqual([['r-otter', 9]]);
      expect(el.querySelector('[data-slot="thread-event-card"]')).toBeNull();
      expect(
        el.querySelector('[data-slot="thread-event-dismissed"]'),
      ).toBeNull();
    });

    it('draws nothing for a card the daemon says was dismissed, on any device', () => {
      const el = render(
        <Dismissable
          initial={new Map([['r-otter', 9]])}
          seq={9}
          newest={new Map([['r-otter', 9]])}
        />,
      );
      expect(el.querySelector('[data-slot="thread-event-card"]')).toBeNull();
    });

    it("draws the thread's next finish as a new card after its last one was dismissed", () => {
      const el = render(
        <Dismissable
          initial={new Map([['r-otter', 9]])}
          seq={14}
          newest={new Map([['r-otter', 14]])}
        />,
      );
      expect(card(el).dataset.run).toBe('r-otter');
      expect(
        el.querySelector('[data-slot="thread-event-dismiss"]'),
      ).not.toBeNull();
    });

    it('offers no Dismiss where no dismissal is kept, outside the manager chat', () => {
      const el = render(
        <ThreadEventRow row={DONE_ROW('r-otter', 'Finished')} seq={9} />,
      );
      expect(card(el).dataset.run).toBe('r-otter');
      expect(el.querySelector('[data-slot="thread-event-dismiss"]')).toBeNull();
    });

    it('offers Dismiss on a finished thread only', () => {
      const sent = render(
        <ThreadEventCard kind="sent" runId="r-otter" title="Otter" />,
      );
      expect(
        sent.querySelector('[data-slot="thread-event-dismiss"]'),
      ).toBeNull();
    });
  });
});

describe('ThreadEventCard — archived Done card', () => {
  const slot = (el: HTMLElement, name: string) =>
    el.querySelector<HTMLButtonElement>(`[data-slot="${name}"]`);

  function drawDone(
    archived: ThreadArchived | null,
    unarchive: () => void,
  ): React.ReactElement {
    return (
      <ThreadArchivedContext.Provider value={archived}>
        <ThreadArchiveContext.Provider value={() => vi.fn()}>
          <ThreadUnarchiveContext.Provider value={() => unarchive}>
            <ThreadOpenContext.Provider value={() => undefined}>
              <ThreadEventCard
                kind="done"
                runId="r-otter"
                title="Otter"
                text="Frozen summary"
              />
            </ThreadOpenContext.Provider>
          </ThreadUnarchiveContext.Provider>
        </ThreadArchiveContext.Provider>
      </ThreadArchivedContext.Provider>
    );
  }

  it('shows the Archived badge and Unarchive, no Archive and no summary, and unarchives through the provided action', () => {
    const unarchive = vi.fn();
    const el = render(
      drawDone(new Map([['r-otter', '2026-11-20T10:00:00Z']]), unarchive),
    );

    expect(
      el.querySelector('[data-slot="thread-archived-badge"]')?.textContent,
    ).toBe('Archived');
    expect(
      [
        ...el.querySelectorAll<HTMLElement>(
          '[data-slot="thread-head-archive"], [data-slot="thread-event-archive"], [data-slot="thread-event-unarchive"]',
        ),
      ].map((control) => control.dataset.slot),
    ).toEqual(['thread-event-unarchive']);
    expect(slot(el, 'thread-event-open')).not.toBeNull();
    expect(el.querySelector('[data-slot="thread-event-text"]')).toBeNull();
    expect(
      el.querySelector('[data-slot="thread-event-archived"]')?.className,
    ).toContain('opacity-70');

    act(() => slot(el, 'thread-event-unarchive')!.click());
    expect(unarchive).toHaveBeenCalledTimes(1);
  });

  it('flips back to the whole card when the same card sees the map change to null', () => {
    let setMap: (next: ThreadArchived) => void = () => undefined;
    function Flip(): React.ReactElement {
      const [map, set] = useState<ThreadArchived>(
        new Map([['r-otter', '2026-11-20T10:00:00Z']]),
      );
      setMap = set;
      return drawDone(map, vi.fn());
    }
    const el = render(<Flip />);
    expect(
      el.querySelector('[data-slot="thread-archived-badge"]'),
    ).not.toBeNull();

    act(() => setMap(new Map([['r-otter', null]])));
    expect(el.querySelector('[data-slot="thread-archived-badge"]')).toBeNull();
    expect(
      [
        ...el.querySelectorAll<HTMLElement>(
          '[data-slot="thread-head-archive"], [data-slot="thread-event-archive"], [data-slot="thread-event-unarchive"]',
        ),
      ].map((control) => control.dataset.slot),
    ).toEqual(['thread-event-archive']);
    expect(
      el.querySelector('[data-slot="thread-event-text"]')?.textContent,
    ).toContain('Frozen summary');
  });

  it('does not dim a thread the map has not read yet', () => {
    const el = render(drawDone(new Map(), vi.fn()));
    expect(el.querySelector('[data-slot="thread-event-archived"]')).toBeNull();
  });
});
