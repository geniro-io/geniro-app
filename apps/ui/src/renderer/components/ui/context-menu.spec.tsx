// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ContextMenu, useContextMenu } from './context-menu';
import type { MenuGroup } from './menu';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: { root: Root; container: HTMLElement }[] = [];

async function mount(ui: React.ReactElement): Promise<HTMLElement> {
  const container = document.createElement('div');
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

const GROUPS: MenuGroup[] = [
  { items: [{ value: 'rename', label: 'Rename' }] },
  { items: [{ value: 'delete', label: 'Delete permanently' }] },
];

const anchorOf = (): HTMLElement | null =>
  document.querySelector('[data-slot="context-menu-anchor"]');

describe('ContextMenu', () => {
  it('draws nothing at all while it is closed', async () => {
    const container = await mount(
      <ContextMenu
        point={null}
        groups={GROUPS}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(container.textContent).toBe('');
    expect(anchorOf()).toBeNull();
  });

  it('parks its anchor AT the point, so the panel opens where the click was', async () => {
    // The anchor is the whole mechanism: `Menu` measures a real element, so a
    // synthetic rect would not do — and the coordinates are the only thing
    // separating this from a trigger-anchored dropdown.
    await mount(
      <ContextMenu
        point={{ x: 240, y: 96 }}
        groups={GROUPS}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const anchor = anchorOf();
    expect(anchor).not.toBeNull();
    expect(anchor!.style.left).toBe('240px');
    expect(anchor!.style.top).toBe('96px');
    // Position and size are what make it an anchor rather than a visible
    // element; the class carries both, and jsdom computes no layout.
    expect(anchor!.className).toContain('fixed');
    expect(anchor!.className).toContain('size-px');
  });

  it('draws every group it is given', async () => {
    await mount(
      <ContextMenu
        point={{ x: 10, y: 10 }}
        groups={GROUPS}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(
      [...document.querySelectorAll('[role="option"]')].map((el) =>
        el.textContent?.trim(),
      ),
    ).toEqual(['Rename', 'Delete permanently']);
  });

  it('reports the row that was chosen', async () => {
    const onSelect = vi.fn();
    await mount(
      <ContextMenu
        point={{ x: 10, y: 10 }}
        groups={GROUPS}
        onSelect={onSelect}
        onClose={vi.fn()}
      />,
    );
    await act(async () => {
      [...document.querySelectorAll('[role="option"]')]
        .find((el) => el.textContent?.trim() === 'Delete permanently')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onSelect).toHaveBeenCalledWith('delete');
  });
});

describe('useContextMenu', () => {
  function Probe(): React.JSX.Element {
    const { point, onContextMenu, close } = useContextMenu();
    return (
      <div data-testid="surface" onContextMenu={onContextMenu}>
        <span data-testid="point">{point ? `${point.x},${point.y}` : '—'}</span>
        <button type="button" onClick={close}>
          close
        </button>
      </div>
    );
  }

  const raise = async (
    container: HTMLElement,
    x: number,
    y: number,
  ): Promise<MouseEvent> => {
    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
    });
    await act(async () => {
      container.querySelector('[data-testid="surface"]')!.dispatchEvent(event);
    });
    return event;
  };

  it('opens at the pointer and PREVENTS the platform menu', async () => {
    const container = await mount(<Probe />);
    const event = await raise(container, 42, 84);
    expect(container.querySelector('[data-testid="point"]')?.textContent).toBe(
      '42,84',
    );
    // The prevention is not tidiness: it is what stops Chromium raising the
    // WebContents `context-menu` event `main/context-menu.ts` answers, so the
    // app's own panel and the platform's can never both appear.
    expect(event.defaultPrevented).toBe(true);
  });

  it('closes again', async () => {
    const container = await mount(<Probe />);
    await raise(container, 1, 2);
    await act(async () => {
      container.querySelector('button')!.click();
    });
    expect(container.querySelector('[data-testid="point"]')?.textContent).toBe(
      '—',
    );
  });
});
