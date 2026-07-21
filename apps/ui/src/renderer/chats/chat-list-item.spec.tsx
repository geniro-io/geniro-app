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
    onRename: vi.fn(),
    ...overrides,
  };
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
    const chat = await mount(<ChatListItem {...props()} />);
    // The label row holds only the truncated label + the rename pencil for a
    // 1:1 chat; a workflow run gets one leading glyph.
    const chatIcons = chat.querySelectorAll('li > span:first-child > svg');
    expect(chatIcons.length).toBe(0);
    const wf = await mount(<ChatListItem {...props({ isWorkflow: true })} />);
    expect(wf.querySelectorAll('li > span:first-child > svg').length).toBe(1);
  });

  it('rename button fires onRename WITHOUT activating the row', async () => {
    const p = props();
    const container = await mount(<ChatListItem {...p} />);
    const rename = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Rename Review team"]',
    );
    expect(rename).not.toBeNull();
    await act(async () => {
      rename?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(p.onRename).toHaveBeenCalledOnce();
    expect(p.onRename).toHaveBeenCalledWith('run-1');
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
