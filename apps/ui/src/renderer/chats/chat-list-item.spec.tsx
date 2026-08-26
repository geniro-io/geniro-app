// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatListItem } from './chat-list-item';
import { HELD_ACTIVITY, STANDING_ACTIVITY } from './run-status';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: { root: Root; container: HTMLElement }[] = [];

async function mount(ui: React.ReactElement): Promise<HTMLElement> {
  const container = document.createElement('ul');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(ui);
  });
  return container;
}

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

function props(
  overrides: Partial<React.ComponentProps<typeof ChatListItem>> = {},
) {
  return {
    runId: 'run-1',
    label: 'Review team',
    isWorkflow: false,
    status: 'completed' as const,
    lastMessage: 'All checks passed on the auth module.',
    lastActivityAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    active: false,
    onActivate: vi.fn(),
    onRename: vi.fn(async () => {}),
    onDelete: vi.fn(),
    ...overrides,
  };
}

const inputOf = (container: HTMLElement): HTMLInputElement =>
  container.querySelector('input')!;

const buttonLabelled = (
  container: HTMLElement,
  label: string,
): HTMLButtonElement =>
  container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;

/** Type into the row's rename field the way React's value tracker sees it. */
async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function press(input: HTMLInputElement, key: string): Promise<void> {
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

describe('ChatListItem', () => {
  it('renders the label, the last message, and the relative activity time', async () => {
    const container = await mount(<ChatListItem {...props()} />);
    expect(container.textContent).toContain('Review team');
    expect(container.textContent).toContain('All checks passed');
    expect(container.textContent).toContain('completed');
    expect(container.textContent).toContain('5m');
  });

  it('spins the status icon and HIDES the activity time while running', async () => {
    const container = await mount(
      <ChatListItem {...props({ status: 'running' })} />,
    );
    expect(container.querySelector('svg.animate-spin')).not.toBeNull();
    expect(container.textContent).toContain('running');
    expect(container.textContent).not.toContain('5m');
  });

  it('LEADS the status word with its glyph — running exactly like completed', async () => {
    // The spinner used to be pushed to the far right of the line while every
    // other state kept its glyph in front of the word, so one column was read
    // from two places. Asserted as document order inside the status line
    // itself, which is the thing the eye actually follows.
    for (const status of ['running', 'completed'] as const) {
      const container = await mount(<ChatListItem {...props({ status })} />);
      const icon = container.querySelector<SVGElement>(
        `svg[data-status="${status}"]`,
      );
      expect(icon).not.toBeNull();
      const line = icon!.parentElement!;
      expect(line.firstElementChild).toBe(icon);
      expect(line.textContent?.startsWith(status)).toBe(true);
    }
  });

  it('does not animate a terminal status icon', async () => {
    const container = await mount(
      <ChatListItem {...props({ status: 'failed' })} />,
    );
    expect(container.querySelector('svg.animate-spin')).toBeNull();
    expect(container.textContent).toContain('failed');
  });

  it('tones the status per state (success / destructive / muted)', async () => {
    const completed = await mount(<ChatListItem {...props()} />);
    expect(completed.querySelector('svg.text-success')).not.toBeNull();
    const failed = await mount(
      <ChatListItem {...props({ status: 'failed' })} />,
    );
    expect(failed.querySelector('svg.text-destructive')).not.toBeNull();
    const cancelled = await mount(
      <ChatListItem {...props({ status: 'cancelled' })} />,
    );
    expect(cancelled.querySelector('svg.text-muted-foreground')).not.toBeNull();
  });

  it('shows the workflow glyph only for workflow runs', async () => {
    // The label row is the content stack's first span (the li's first child
    // is the activation overlay button): only the truncated label + the
    // rename pencil for a 1:1 chat; a workflow run gets one leading glyph.
    const chat = await mount(<ChatListItem {...props()} />);
    const chatIcons = chat.querySelectorAll(
      'li > div > span:first-child > svg',
    );
    expect(chatIcons.length).toBe(0);
    const wf = await mount(<ChatListItem {...props({ isWorkflow: true })} />);
    expect(
      wf.querySelectorAll('li > div > span:first-child > svg').length,
    ).toBe(1);
  });

  it('rename opens an inline field IN the row — no dialog, and no activation', async () => {
    const p = props();
    const container = await mount(<ChatListItem {...p} />);
    expect(inputOf(container)).toBeNull();
    await act(async () => {
      buttonLabelled(container, 'Rename Review team').dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });
    const input = inputOf(container);
    // The name is edited where it is read: an input in the row, prefilled and
    // selected, and nothing was sent yet.
    expect(input).not.toBeNull();
    expect(input.value).toBe('Review team');
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe('Review team'.length);
    expect(p.onRename).not.toHaveBeenCalled();
    expect(p.onActivate).not.toHaveBeenCalled();
  });

  it('the row-activation overlay steps aside while the field is open', async () => {
    // The overlay spans the whole row; left mounted it swallows every click
    // beside the input and competes for focus with it.
    const p = props();
    const container = await mount(<ChatListItem {...p} />);
    expect(buttonLabelled(container, 'Review team')).not.toBeNull();
    await act(async () => {
      buttonLabelled(container, 'Rename Review team').click();
    });
    expect(buttonLabelled(container, 'Review team')).toBeNull();

    await press(inputOf(container), 'Escape');
    expect(buttonLabelled(container, 'Review team')).not.toBeNull();
  });

  it('the content stack re-enables pointer events for the rename INPUT', async () => {
    // Asserted on the emitted class, not on computed style: Tailwind is a
    // build step and jsdom loads no stylesheet, so `getComputedStyle` here
    // reports the default for every element and would pass with the escape
    // deleted. The class IS the mechanism, so the class is the observable.
    const container = await mount(<ChatListItem {...props()} />);
    const stack = container.querySelector('li > div')!;
    expect(stack.className).toContain('pointer-events-none');
    // A bare <input> inherits that and becomes unclickable without this.
    expect(stack.className).toContain('[&_input]:pointer-events-auto');
  });

  it('Enter commits the trimmed name; Escape reverts without a request', async () => {
    const p = props();
    const container = await mount(<ChatListItem {...p} />);
    await act(async () => {
      buttonLabelled(container, 'Rename Review team').click();
    });
    await typeInto(inputOf(container), '  Auth deep-dive  ');
    await press(inputOf(container), 'Enter');
    expect(p.onRename).toHaveBeenCalledWith('run-1', 'Auth deep-dive');
    expect(inputOf(container)).toBeNull();

    await act(async () => {
      buttonLabelled(container, 'Rename Review team').click();
    });
    await typeInto(inputOf(container), 'Discarded');
    await press(inputOf(container), 'Escape');
    expect(inputOf(container)).toBeNull();
    expect(p.onRename).toHaveBeenCalledOnce();

    // Reopening starts from the run's CURRENT label, never the abandoned
    // "Discarded" draft. The deleted rename dialog pinned this; the behaviour
    // survived into the row (`setDraft(label)` on open) but nothing asserted
    // it, so removing that line left every test green.
    await act(async () => {
      buttonLabelled(container, 'Rename Review team').click();
    });
    expect(inputOf(container).value).toBe('Review team');
  });

  it('clicking away commits — the edit is not lost for leaving the field', async () => {
    const p = props();
    const container = await mount(<ChatListItem {...p} />);
    await act(async () => {
      buttonLabelled(container, 'Rename Review team').click();
    });
    await typeInto(inputOf(container), 'Clicked away');
    await act(async () => {
      // React's onBlur delegates from the native focusout event.
      inputOf(container).dispatchEvent(
        new FocusEvent('focusout', { bubbles: true }),
      );
    });
    expect(p.onRename).toHaveBeenCalledWith('run-1', 'Clicked away');
    expect(inputOf(container)).toBeNull();
  });

  it('an unchanged or empty name is not worth a request', async () => {
    const p = props();
    const container = await mount(<ChatListItem {...p} />);
    await act(async () => {
      buttonLabelled(container, 'Rename Review team').click();
    });
    await press(inputOf(container), 'Enter');
    expect(p.onRename).not.toHaveBeenCalled();

    await act(async () => {
      buttonLabelled(container, 'Rename Review team').click();
    });
    // An empty name would leave the row unidentifiable.
    await typeInto(inputOf(container), '   ');
    await press(inputOf(container), 'Enter');
    expect(p.onRename).not.toHaveBeenCalled();
  });

  it('a failed rename keeps the field open, carrying the reason', async () => {
    const p = props({
      onRename: vi.fn().mockRejectedValue(new Error('daemon PATCH failed')),
    });
    const container = await mount(<ChatListItem {...p} />);
    await act(async () => {
      buttonLabelled(container, 'Rename Review team').click();
    });
    await typeInto(inputOf(container), 'Auth deep-dive');
    await press(inputOf(container), 'Enter');
    // Closing would discard the typed name and hide the failure.
    expect(inputOf(container)).not.toBeNull();
    expect(inputOf(container).value).toBe('Auth deep-dive');
    expect(container.textContent).toContain('daemon PATCH failed');
  });

  it('reverting a failed rename takes the failure message with it', async () => {
    // Escape abandons the edit, so the row is back to showing its stored name
    // — a red line about a name the user is no longer typing describes nothing
    // on screen, and it stays under the row until someone renames again.
    const p = props({
      onRename: vi.fn().mockRejectedValue(new Error('daemon PATCH failed')),
    });
    const container = await mount(<ChatListItem {...p} />);
    await act(async () => {
      buttonLabelled(container, 'Rename Review team').click();
    });
    await typeInto(inputOf(container), 'Auth deep-dive');
    await press(inputOf(container), 'Enter');
    expect(container.textContent).toContain('daemon PATCH failed');

    await press(inputOf(container), 'Escape');
    expect(inputOf(container)).toBeNull();
    expect(container.textContent).toContain('Review team');
    expect(container.textContent).not.toContain('daemon PATCH failed');
  });

  it('a WORKFLOW row offers delete but not rename', async () => {
    // Its NAME comes from the workflow it ran, so renaming here would read as
    // editing the library entry from another view. Deleting does not: the row
    // is one run's history, and the workflow stays in the library. Gating the
    // two together is what left these rows undeletable.
    const p = props({ isWorkflow: true });
    const container = await mount(<ChatListItem {...p} />);
    expect(buttonLabelled(container, 'Rename Review team')).toBeNull();

    await act(async () => {
      buttonLabelled(container, 'Delete Review team').dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });
    expect(p.onDelete).toHaveBeenCalledWith('run-1');
    // The row still activates.
    expect(buttonLabelled(container, 'Review team')).not.toBeNull();
  });

  it('delete asks the parent WITHOUT activating the row', async () => {
    const p = props();
    const container = await mount(<ChatListItem {...p} />);
    await act(async () => {
      buttonLabelled(container, 'Delete Review team').dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });
    expect(p.onDelete).toHaveBeenCalledWith('run-1');
    expect(p.onActivate).not.toHaveBeenCalled();
  });

  it('clicking the row activates it via a REAL button that keeps li semantics', async () => {
    const p = props();
    const container = await mount(<ChatListItem {...p} />);
    // The li keeps its listitem role (no role="button") — ARIA forbids the
    // nested rename control inside a button role.
    expect(container.querySelector('li')?.getAttribute('role')).toBeNull();
    const activate = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Review team"]',
    );
    expect(activate).not.toBeNull();
    await act(async () => {
      activate!.click();
    });
    expect(p.onActivate).toHaveBeenCalledOnce();
    expect(p.onActivate).toHaveBeenCalledWith('run-1');
  });

  it('omits the preview line when the run has no messages yet', async () => {
    const container = await mount(
      <ChatListItem {...props({ lastMessage: null })} />,
    );
    expect(container.textContent).not.toContain('All checks passed');
  });
});

describe('ChatListItem — the running row never goes phrase-less', () => {
  it('falls back to the standing phrase when the daemon has named nothing', async () => {
    // REPORTED as the status "blinking" on a thread. The daemon announces
    // `running Bash` on a tool call and NULL on its result, meaning "working,
    // nothing named" — the transcript's live row has always read it that way,
    // and this row read it as "erase", so the phrase vanished once per tool.
    const container = await mount(
      <ChatListItem {...props({ status: 'running', activity: null })} />,
    );

    expect(container.textContent).toContain(STANDING_ACTIVITY);
  });

  it('prefers the daemon’s phrase whenever there is one', async () => {
    const container = await mount(
      <ChatListItem
        {...props({ status: 'running', activity: 'running Bash' })}
      />,
    );

    expect(container.textContent).toContain('running Bash');
    expect(container.textContent).not.toContain(STANDING_ACTIVITY);
  });

  it('marks an unseen row on the ROW — a bar and a wash, not only a dot', async () => {
    // REPORTED twice: the dot alone was missed at 6px and again at 10px. A
    // mark the size of a glyph competes with every other glyph on the rail,
    // so the row itself carries the signal now — which is what "дополнительная
    // линия или выделение" asked for.
    const container = await mount(
      <ChatListItem {...props({ unseen: true })} />,
    );
    const row = container.querySelector('li')!;

    expect(row.className).toContain('before:bg-primary');
    expect(row.className).toContain('bg-primary/10');
    // The dot stays: it is the marker carrying the accessible name, and the
    // group header draws the same one when a fold hides these rows.
    expect(row.querySelector('[data-slot="unseen-dot"]')).not.toBeNull();
  });

  it('leaves a SEEN row unmarked — no bar, no wash', async () => {
    const container = await mount(<ChatListItem {...props()} />);
    const row = container.querySelector('li')!;

    expect(row.className).not.toContain('before:bg-primary');
    expect(row.className).not.toContain('bg-primary/10');
    expect(row.querySelector('[data-slot="unseen-dot"]')).toBeNull();
  });

  it('yields the wash to the ACTIVE row, keeping one highlight per row', async () => {
    // Two backgrounds on one row read as a third state. The bar stays, since
    // it is the mark rather than the highlight.
    const container = await mount(
      <ChatListItem {...props({ unseen: true, active: true })} />,
    );
    const row = container.querySelector('li')!;

    expect(row.className).not.toContain('bg-primary/10');
    expect(row.className).toContain('before:bg-primary');
  });

  it('says nothing of the sort once the run has STOPPED', async () => {
    // The fallback describes work in progress. A settled row showing it would
    // claim the run was still going — worse than the blink it replaces.
    const container = await mount(
      <ChatListItem {...props({ status: 'completed', activity: null })} />,
    );

    expect(container.textContent).not.toContain(STANDING_ACTIVITY);
  });
});

describe('ChatListItem — a HELD row reads as live, not as history', () => {
  it('keeps the daemon’s phrase and drops the relative time', async () => {
    // The reported row: `⟳ idle · 24m`, on a thread that turned out to be
    // waiting on six sub-agents. Both halves said "finished a while
    // ago" — the badge in a word, the `24m` in a number — so both are pinned
    // here. The elapsed clock belongs to a run that has STOPPED, and this one
    // has not: its turn is open and its process is up.
    const container = await mount(
      <ChatListItem
        {...props({
          status: 'held',
          activity: 'waiting on 6 sub-agents',
        })}
      />,
    );

    expect(container.textContent).toContain('waiting on 6 sub-agents');
    // `formatRelativeTime` renders the row's 5-minute-old `lastActivityAt` as
    // the bare `5m` — spelled the way the component actually produces it, not
    // as a plausible-looking `5m ago` that no branch of this row can emit and
    // that would therefore pass with the gate deleted.
    expect(container.textContent).not.toContain('5m');
  });

  it('falls back to its OWN standing phrase, not the running one', async () => {
    // The activity plane is events-only, so a window that reconnected
    // mid-hold has no phrase to show. `Working…` there would stutter under a
    // badge already reading `working` — and would describe an agent that is
    // thinking, which a held one is not.
    const container = await mount(
      <ChatListItem {...props({ status: 'held', activity: null })} />,
    );

    expect(container.textContent).toContain(HELD_ACTIVITY);
    expect(container.textContent).not.toContain(STANDING_ACTIVITY);
  });
});
