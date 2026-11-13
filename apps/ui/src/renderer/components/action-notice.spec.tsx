// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ActionNotice, DEFAULT_ACTION_NOTICE_MS } from './action-notice';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function renderNotice(
  props: Partial<React.ComponentProps<typeof ActionNotice>>,
): void {
  act(() => {
    root.render(
      <ActionNotice
        message="Learning signal in “Refactor the parser”"
        onDismiss={vi.fn()}
        {...props}
      />,
    );
  });
}

function noticeOf(): HTMLElement {
  return container.querySelector<HTMLElement>('[data-slot="action-notice"]')!;
}

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function hover(target: HTMLElement, entering: boolean): void {
  act(() => {
    target.dispatchEvent(
      new MouseEvent(entering ? 'mouseover' : 'mouseout', {
        bubbles: true,
      }),
    );
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe('ActionNotice', () => {
  it('withdraws itself after ten seconds by default', () => {
    const onDismiss = vi.fn();
    renderNotice({ onDismiss });

    advance(DEFAULT_ACTION_NOTICE_MS - 1);
    expect(onDismiss).not.toHaveBeenCalled();

    advance(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('withdraws after the duration it is given', () => {
    const onDismiss = vi.fn();
    renderNotice({ onDismiss, durationMs: 2_000 });

    advance(1_999);
    expect(onDismiss).not.toHaveBeenCalled();

    advance(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('a pointer over it pauses the countdown, and leaving resumes it with the time left', () => {
    const onDismiss = vi.fn();
    renderNotice({ onDismiss, durationMs: 10_000 });

    advance(4_000);
    hover(noticeOf(), true);
    advance(60_000);
    expect(onDismiss).not.toHaveBeenCalled();

    hover(noticeOf(), false);
    advance(5_999);
    expect(onDismiss).not.toHaveBeenCalled();

    advance(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('the close control dismisses it at once', () => {
    const onDismiss = vi.fn();
    renderNotice({ onDismiss });

    act(() => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]')!
        .click();
    });

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('draws each action as a button that runs its own handler', () => {
    const extract = vi.fn();
    const notNow = vi.fn();
    renderNotice({
      actions: [
        { label: 'Extract lessons', onAction: extract },
        { label: 'Not now', onAction: notNow, variant: 'ghost' },
      ],
    });

    const buttons = [
      ...noticeOf().querySelectorAll<HTMLButtonElement>('button'),
    ];
    expect(buttons.map((button) => button.textContent?.trim())).toEqual([
      'Extract lessons',
      'Not now',
      '',
    ]);

    act(() => buttons[1]!.click());
    expect(notNow).toHaveBeenCalledTimes(1);
    expect(extract).not.toHaveBeenCalled();
  });

  it('announces its message politely, as a status', () => {
    renderNotice({});

    expect(noticeOf().getAttribute('role')).toBe('status');
    expect(noticeOf().textContent).toContain('Learning signal');
  });
});
