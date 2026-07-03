// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApprovalCard } from './approval-card';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render(element: React.ReactElement): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(element);
  });
  return container;
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

describe('ApprovalCard', () => {
  it('renders the tool + input and fires the verdict callbacks while pending', () => {
    const onRespond = vi.fn();
    const el = render(
      <ApprovalCard
        toolName="Write"
        input={{ file_path: 'a.txt' }}
        verdict={null}
        onRespond={onRespond}
      />,
    );
    expect(el.textContent).toContain('Write');
    expect(el.textContent).toContain('a.txt');

    const buttons = [...el.querySelectorAll('button')];
    const approve = buttons.find((b) => b.textContent === 'Approve')!;
    const deny = buttons.find((b) => b.textContent === 'Deny')!;
    act(() => {
      approve.click();
    });
    expect(onRespond).toHaveBeenLastCalledWith(true);
    act(() => {
      deny.click();
    });
    expect(onRespond).toHaveBeenLastCalledWith(false);
  });

  it('renders the settled state with no buttons once a verdict exists', () => {
    const el = render(
      <ApprovalCard
        toolName="Bash"
        input={{ command: 'ls' }}
        verdict={false}
        onRespond={vi.fn()}
      />,
    );
    expect(el.querySelectorAll('button')).toHaveLength(0);
    expect(el.textContent).toContain('✗ denied');
  });
});
