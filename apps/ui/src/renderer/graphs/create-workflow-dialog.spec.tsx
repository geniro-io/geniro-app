// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CreateWorkflowDialog } from './create-workflow-dialog';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

const onClose = vi.fn();
const onCreate = vi.fn();

function render(
  props: { open?: boolean; busy?: boolean; error?: string | null } = {},
): void {
  act(() => {
    root.render(
      <CreateWorkflowDialog
        open={props.open ?? true}
        busy={props.busy ?? false}
        error={props.error ?? null}
        onClose={onClose}
        onCreate={onCreate}
      />,
    );
  });
}

function type(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  act(() => {
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function nameInput(): HTMLInputElement {
  return container.querySelector<HTMLInputElement>('#workflow-name')!;
}

function descriptionInput(): HTMLTextAreaElement {
  return container.querySelector<HTMLTextAreaElement>('#workflow-description')!;
}

function createButton(): HTMLButtonElement {
  return Array.from(container.querySelectorAll('button')).find((b) =>
    /Create|Creating…/.test(b.textContent ?? ''),
  )!;
}

function submit(): void {
  act(() => {
    container
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

describe('CreateWorkflowDialog', () => {
  it('disables Create until a non-blank name is typed', () => {
    render();
    expect(createButton().disabled).toBe(true);

    type(nameInput(), '   ');
    expect(createButton().disabled).toBe(true);

    type(nameInput(), 'Review team');
    expect(createButton().disabled).toBe(false);
  });

  it('submits the trimmed name and description', () => {
    render();
    type(nameInput(), '  Review team  ');
    type(descriptionInput(), '  Codes then reviews.  ');
    submit();

    expect(onCreate).toHaveBeenCalledWith({
      name: 'Review team',
      description: 'Codes then reviews.',
    });
  });

  it('omits an empty description from the meta', () => {
    render();
    type(nameInput(), 'Solo');
    submit();

    expect(onCreate).toHaveBeenCalledWith({ name: 'Solo' });
  });

  it('does not submit a blank form', () => {
    render();
    submit();
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('Cancel closes without creating', () => {
    render();
    const cancel = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Cancel',
    )!;
    act(() => {
      cancel.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalled();
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('blocks re-submitting while busy and shows the progress label', () => {
    render({ busy: true });
    type(nameInput(), 'Review team');
    expect(createButton().textContent).toBe('Creating…');
    expect(createButton().disabled).toBe(true);
    submit();
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('shows a create error inside the dialog', () => {
    render({ error: 'boom' });
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain(
      'boom',
    );
  });

  it('clears the previous draft when reopened', () => {
    render();
    type(nameInput(), 'Old draft');
    render({ open: false });
    render({ open: true });
    expect(nameInput().value).toBe('');
  });
});
