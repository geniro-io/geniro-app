// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { SettingRow } from './setting-row';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render(node: React.ReactNode): HTMLElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(node);
  });
  const row = container.querySelector<HTMLElement>('[data-slot="setting-row"]');
  if (row === null) {
    throw new Error('the row did not render');
  }
  return row;
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

describe('SettingRow', () => {
  it('pairs the label with its control, label first', () => {
    const row = render(
      <SettingRow label="Approval">
        <button type="button">auto-approve</button>
      </SettingRow>,
    );

    expect(row.children).toHaveLength(2);
    expect(row.children[0]?.textContent).toBe('Approval');
    expect(row.children[1]?.textContent).toBe('auto-approve');
  });

  it('CAPS the control at the cell width, which is what makes it truncate', () => {
    // The bug this pins, measured in the builder's inspector at its 240px
    // minimum: `min-w-0` lets the CELL shrink and says nothing about the
    // control inside it, so a `Default profile` chip kept its intrinsic width
    // and ran 38px past its column, over the card's edge. Capping the child is
    // what hands the overflow to the chip's own `truncate` span.
    //
    // A CLASS assertion deliberately: jsdom computes no layout, so the width
    // itself is unobservable here — but which element carries the cap is the
    // DOM fact that decides it, and it is the half that regressed.
    const row = render(
      <SettingRow label="Profile">
        <button type="button">Default profile</button>
      </SettingRow>,
    );

    const cell = row.children[1];
    expect(cell?.className).toContain('[&>*]:max-w-full');
    expect(cell?.className).toContain('min-w-0');
  });

  it('STACKS `compact` under 17rem of container, and columns above it', () => {
    // The reported "они должны влезать в блок": two columns cannot hold a
    // `Default profile` chip in a 240px panel, so the value was truncating to
    // `Defa…`. Below the threshold the row gives up its second COLUMN instead
    // of its value, and the control takes the row's whole width.
    //
    // A CLASS assertion deliberately: jsdom resolves no container queries, so
    // which layout wins at a given width is unobservable here — but which
    // breakpoint the row declares is the DOM fact that decides it.
    const wide = render(
      <SettingRow label="Model">
        <span>opus</span>
      </SettingRow>,
    ).className;
    act(() => {
      root?.unmount();
    });
    container?.remove();
    const narrow = render(
      <SettingRow width="compact" label="Model">
        <span>opus</span>
      </SettingRow>,
    ).className;

    // The dialog is never stacked — it always has the room.
    expect(wide).toContain('grid-cols-[7rem_minmax(0,1fr)]');
    expect(wide).not.toContain('grid-cols-1');
    // Compact is one column by default and two only once the card is wide
    // enough, which is the half that regressed into an ellipsis.
    expect(narrow).toContain('grid-cols-1');
    expect(narrow).toContain('@[17rem]:grid-cols-[5.5rem_minmax(0,1fr)]');
  });

  it('puts a hint under the control, not beside the label', () => {
    // The hint says what flipping this DOES; it belongs with the thing it is
    // about, and in the label column it would push every row's control down.
    const row = render(
      <SettingRow label="Branch" hint="Switched before the chat starts.">
        <span>main</span>
      </SettingRow>,
    );

    const cell = row.children[1];
    expect(cell?.children).toHaveLength(2);
    expect(cell?.children[1]?.textContent).toBe(
      'Switched before the chat starts.',
    );
  });
});
