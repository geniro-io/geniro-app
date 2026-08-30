// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ArchiveFilter } from './archive-filter';

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

const sideNamed = (container: HTMLElement, side: string): HTMLButtonElement =>
  [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
    b.textContent?.includes(side),
  )!;

describe('ArchiveFilter', () => {
  it('marks the side that is showing with aria-pressed', async () => {
    // The pressed state is the only thing telling the two buttons apart for a
    // screen reader — both are always drawn, since the inactive one is the
    // whole affordance for reaching the other side.
    const desk = await mount(
      <ArchiveFilter archived={false} onChange={vi.fn()} />,
    );
    expect(sideNamed(desk, 'Active').getAttribute('aria-pressed')).toBe('true');
    expect(sideNamed(desk, 'Archived').getAttribute('aria-pressed')).toBe(
      'false',
    );

    const shelf = await mount(<ArchiveFilter archived onChange={vi.fn()} />);
    expect(sideNamed(shelf, 'Archived').getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(sideNamed(shelf, 'Active').getAttribute('aria-pressed')).toBe(
      'false',
    );
  });

  it('reports the side as a boolean, not the segment id', async () => {
    // The component speaks the segmented control's `'active' | 'archived'`
    // vocabulary internally and the sidebar's boolean at its edge; a mapping
    // dropped here sends `'archived'` where a `true` is expected.
    const onChange = vi.fn();
    const container = await mount(
      <ArchiveFilter archived={false} onChange={onChange} />,
    );

    await act(async () => {
      sideNamed(container, 'Archived').click();
    });
    expect(onChange).toHaveBeenCalledWith(true);

    await act(async () => {
      sideNamed(container, 'Active').click();
    });
    expect(onChange).toHaveBeenLastCalledWith(false);
  });
});
