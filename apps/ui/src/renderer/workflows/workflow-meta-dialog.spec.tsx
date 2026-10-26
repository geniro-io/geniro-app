// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WorkflowMetaDialog } from './workflow-meta-dialog';

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
const onSubmit = vi.fn();

function render(
  props: {
    open?: boolean;
    busy?: boolean;
    error?: string | null;
    initial?: { name: string; description?: string; maxActiveTurns?: number };
    maxActiveTurnsCeiling?: number | null;
  } = {},
): void {
  act(() => {
    root.render(
      <WorkflowMetaDialog
        open={props.open ?? true}
        busy={props.busy ?? false}
        error={props.error ?? null}
        title="New workflow"
        submitLabel="Create"
        busyLabel="Creating…"
        {...(props.initial ? { initial: props.initial } : {})}
        maxActiveTurnsCeiling={
          props.maxActiveTurnsCeiling === undefined
            ? 8
            : props.maxActiveTurnsCeiling
        }
        onClose={onClose}
        onSubmit={onSubmit}
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

function limitSwitch(): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>('#workflow-limit-turns')!;
}

function capValue(): string | null {
  return (
    container
      .querySelector('[role="spinbutton"]')
      ?.getAttribute('aria-valuenow') ?? null
  );
}

function press(label: string): void {
  act(() => {
    container
      .querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function submitButton(): HTMLButtonElement {
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

describe('WorkflowMetaDialog', () => {
  it('disables submit until a non-blank name is typed', () => {
    render();
    expect(submitButton().disabled).toBe(true);

    type(nameInput(), '   ');
    expect(submitButton().disabled).toBe(true);

    type(nameInput(), 'Review team');
    expect(submitButton().disabled).toBe(false);
  });

  it('submits the trimmed name and description', () => {
    render();
    type(nameInput(), '  Review team  ');
    type(descriptionInput(), '  Codes then reviews.  ');
    submit();

    expect(onSubmit).toHaveBeenCalledWith({
      name: 'Review team',
      description: 'Codes then reviews.',
    });
  });

  it('omits an empty description from the meta', () => {
    render();
    type(nameInput(), 'Solo');
    submit();

    expect(onSubmit).toHaveBeenCalledWith({ name: 'Solo' });
  });

  it('does not submit a blank form', () => {
    render();
    submit();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('Cancel closes without submitting', () => {
    render();
    const cancel = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Cancel',
    )!;
    act(() => {
      cancel.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('blocks re-submitting while busy and shows the progress label', () => {
    render({ busy: true });
    type(nameInput(), 'Review team');
    expect(submitButton().textContent).toBe('Creating…');
    expect(submitButton().disabled).toBe(true);
    submit();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('shows a submit error inside the dialog', () => {
    render({ error: 'boom' });
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain(
      'boom',
    );
  });

  it('prefills the form from initial (the rename flow)', () => {
    render({ initial: { name: 'Demo team', description: 'Fans out work.' } });
    expect(nameInput().value).toBe('Demo team');
    expect(descriptionInput().value).toBe('Fans out work.');
    expect(submitButton().disabled).toBe(false);
  });

  it('clears the previous draft when reopened without initial', () => {
    render();
    type(nameInput(), 'Old draft');
    render({ open: false });
    render({ open: true });
    expect(nameInput().value).toBe('');
  });

  it('resets an abandoned draft back to initial when reopened', () => {
    render({ initial: { name: 'Demo team' } });
    type(nameInput(), 'Half-typed edit');
    render({ open: false, initial: { name: 'Demo team' } });
    render({ open: true, initial: { name: 'Demo team' } });
    expect(nameInput().value).toBe('Demo team');
  });

  it('has no limit of its own until switched on, and says what that means', () => {
    render({ maxActiveTurnsCeiling: 12 });
    expect(limitSwitch().getAttribute('aria-checked')).toBe('false');
    expect(capValue()).toBeNull();
    expect(
      container.querySelector('[data-slot="max-active-turns-ceiling"]')
        ?.textContent,
    ).toBe('up to 12, this Mac’s ceiling');
    type(nameInput(), 'Team');
    submit();
    expect(onSubmit).toHaveBeenCalledWith({ name: 'Team' });
  });

  it('submits the limit set with the stepper once switched on', () => {
    render();
    type(nameInput(), 'Team');
    act(() => {
      limitSwitch().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(capValue()).toBe('4');
    press('Decrease Agents working at once');
    submit();
    expect(onSubmit).toHaveBeenCalledWith({ name: 'Team', maxActiveTurns: 3 });
  });

  it('keeps the limit between 1 and this Mac’s ceiling', () => {
    render({
      initial: { name: 'Team', maxActiveTurns: 2 },
      maxActiveTurnsCeiling: 2,
    });
    expect(capValue()).toBe('2');
    expect(
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="Increase Agents working at once"]',
      )!.disabled,
    ).toBe(true);
    press('Decrease Agents working at once');
    expect(
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="Decrease Agents working at once"]',
      )!.disabled,
    ).toBe(true);
    expect(capValue()).toBe('1');
  });

  it('prefills a saved limit, and drops it when switched off', () => {
    render({ initial: { name: 'Team', maxActiveTurns: 6 } });
    expect(limitSwitch().getAttribute('aria-checked')).toBe('true');
    expect(capValue()).toBe('6');
    act(() => {
      limitSwitch().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    submit();
    expect(onSubmit).toHaveBeenCalledWith({ name: 'Team' });
  });
});
