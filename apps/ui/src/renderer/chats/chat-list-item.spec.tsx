// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatListItem } from './chat-list-item';

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

  it('a WORKFLOW row offers neither rename nor delete', async () => {
    // Its name comes from the workflow it ran and its lifecycle belongs to the
    // Graphs library — both are out of this list's scope.
    const container = await mount(
      <ChatListItem {...props({ isWorkflow: true })} />,
    );
    expect(buttonLabelled(container, 'Rename Review team')).toBeNull();
    expect(buttonLabelled(container, 'Delete Review team')).toBeNull();
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
