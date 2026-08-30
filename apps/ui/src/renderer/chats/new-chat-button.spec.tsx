// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RunConfig } from '../../shared/contracts';
import { NewChatButton } from './new-chat-button';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function config(over: Partial<RunConfig> = {}): RunConfig {
  return {
    id: 'rc-1',
    name: 'Geniro app',
    cwd: '/Users/dev/geniro-app',
    branch: null,
    target: 'claude',
    model: null,
    effort: null,
    contextWindow: null,
    modelParameters: {},
    approval: null,
    configDir: null,
    firstMessage: null,
    ...over,
  };
}

function render(configs: RunConfig[] = [config()]): {
  onNewChat: ReturnType<typeof vi.fn>;
  onApply: ReturnType<typeof vi.fn>;
  onCreate: ReturnType<typeof vi.fn>;
  onManage: ReturnType<typeof vi.fn>;
} {
  const handles = {
    onNewChat: vi.fn(),
    onApply: vi.fn(),
    onCreate: vi.fn(),
    onManage: vi.fn(),
  };
  act(() => {
    root.render(<NewChatButton configs={configs} {...handles} />);
  });
  return handles;
}

const plus = (): HTMLButtonElement =>
  container.querySelector<HTMLButtonElement>('[aria-label="New chat"]')!;

const rows = (): HTMLElement[] => [
  ...container.querySelectorAll<HTMLElement>('[role="option"]'),
];

/** React synthesizes onMouseEnter from a bubbling `mouseover`. */
function hover(el: HTMLElement): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  });
}

function click(el: HTMLElement): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('NewChatButton', () => {
  it('a plain click starts a new chat and opens nothing', () => {
    // The + keeps its one-click meaning. If a click opened the menu instead,
    // the commonest act in the sidebar would cost a second decision.
    const { onNewChat, onApply } = render();

    click(plus());

    expect(onNewChat).toHaveBeenCalledTimes(1);
    expect(onApply).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(0);
  });

  it('hovering reveals the saved configurations', () => {
    render([
      config({ id: 'a', name: 'Geniro app' }),
      config({ id: 'b', name: 'Sibling repo', target: 'cursor-agent' }),
    ]);

    hover(plus());

    const labels = rows().map((row) => row.textContent);
    expect(labels.some((l) => l?.includes('Geniro app'))).toBe(true);
    expect(labels.some((l) => l?.includes('Sibling repo'))).toBe(true);
  });

  it('picking a row hands back that whole configuration', () => {
    // The WHOLE record, not its id — the caller applies every field, and a
    // menu handing back `{id}` alone would satisfy a laxer assertion.
    const wanted = config({ id: 'b', name: 'Sibling repo' });
    const { onApply } = render([
      config({ id: 'a', name: 'Geniro app' }),
      wanted,
    ]);

    hover(plus());
    click(rows().find((r) => r.textContent?.includes('Sibling repo'))!);

    expect(onApply).toHaveBeenCalledWith(wanted);
  });

  it('offers creating a configuration from the same menu', () => {
    // The row replaces the separate bookmark button: everything about how a
    // new chat starts is reached from the control that starts one.
    const { onCreate, onApply } = render();

    hover(plus());
    click(rows().find((r) => r.textContent?.includes('New configuration'))!);

    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onApply).not.toHaveBeenCalled();
  });

  it('offers managing them, but only once there is one to manage', () => {
    const { onManage } = render();
    hover(plus());
    click(
      rows().find((r) => r.textContent?.includes('Manage configurations'))!,
    );
    expect(onManage).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
    container.remove();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    render([]);
    hover(plus());
    const labels = rows().map((row) => row.textContent);
    // Nothing to manage yet, so the row that would open an empty list is gone —
    // while creating the first one stays offered.
    expect(labels.some((l) => l?.includes('Manage configurations'))).toBe(
      false,
    );
    expect(labels.some((l) => l?.includes('New configuration'))).toBe(true);
  });

  it('survives the pointer crossing the gap between button and panel', () => {
    // The panel hangs 6px below the trigger and that gap belongs to neither, so
    // a menu that closed on the first mouseleave could never be reached.
    vi.useFakeTimers();
    render();
    hover(plus());

    act(() => {
      plus().dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    });
    // Back inside before the grace period elapses.
    act(() => {
      vi.advanceTimersByTime(60);
    });
    hover(plus());
    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(rows().length).toBeGreaterThan(0);
  });

  it('the keyboard can reach the configurations too', () => {
    // The button's own click is the new thread, so without this the menu would
    // be pointer-only.
    render();

    act(() => {
      plus().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      );
    });

    expect(rows().length).toBeGreaterThan(0);
  });
});
