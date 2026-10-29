// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';

import { MEMORY_PROJECTS } from '../__fixtures__/memories';
import {
  MEMORY_BODY_MAX_BYTES,
  MEMORY_TITLE_MAX_CHARS,
  MemoryForm,
  type MemoryFormValue,
} from './memory-form';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

const VALID: MemoryFormValue = {
  title: 'A sent invoice is never edited',
  body: 'Issue a credit note.',
  type: 'feedback',
  projectId: null,
};

interface Spies {
  onSubmit: Mock<() => void>;
  onCancel: Mock<() => void>;
  latest: { value: MemoryFormValue };
}

function render(
  initial: MemoryFormValue,
  props: { saving?: boolean; error?: string | null } = {},
): { el: HTMLDivElement; spies: Spies } {
  const spies: Spies = {
    onSubmit: vi.fn<() => void>(),
    onCancel: vi.fn<() => void>(),
    latest: { value: initial },
  };
  function Harness(): React.JSX.Element {
    const [value, setValue] = useState(initial);
    return (
      <MemoryForm
        value={value}
        projects={MEMORY_PROJECTS}
        saving={props.saving ?? false}
        error={props.error ?? null}
        submitLabel="Save note"
        onChange={(next) => {
          spies.latest.value = next;
          setValue(next);
        }}
        onSubmit={spies.onSubmit}
        onCancel={spies.onCancel}
      />
    );
  }
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<Harness />);
  });
  return { el: container, spies };
}

function type(
  field: HTMLInputElement | HTMLTextAreaElement,
  text: string,
): void {
  const proto =
    field instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(field, text);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const titleField = (el: HTMLElement): HTMLInputElement =>
  el.querySelector<HTMLInputElement>('[data-slot="input"]')!;
const bodyField = (el: HTMLElement): HTMLTextAreaElement =>
  el.querySelector<HTMLTextAreaElement>('[data-slot="textarea"]')!;
const submit = (el: HTMLElement): HTMLButtonElement =>
  [...el.querySelectorAll('button')].find(
    (button) => button.textContent === 'Save note',
  )!;
const cancel = (el: HTMLElement): HTMLButtonElement =>
  [...el.querySelectorAll('button')].find(
    (button) => button.textContent === 'Cancel',
  )!;

function press(target: HTMLElement, key: string): void {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
    );
  });
}

function pick(el: HTMLElement, trigger: number, label: string): void {
  act(() => {
    el.querySelectorAll<HTMLElement>('[data-menu-trigger]')[trigger]!.click();
  });
  const option = [...el.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (candidate) => candidate.textContent?.includes(label),
  );
  act(() => {
    option!.click();
  });
}

describe('MemoryForm', () => {
  it('calls onSubmit from the button once title and note are filled in', () => {
    const { el, spies } = render(VALID);
    expect(submit(el).disabled).toBe(false);
    act(() => submit(el).click());
    expect(spies.onSubmit).toHaveBeenCalledTimes(1);
  });

  it('disables submit while saving', () => {
    const { el } = render(VALID, { saving: true });
    expect(submit(el).disabled).toBe(true);
  });

  it('disables submit for a blank title or a blank note', () => {
    expect(submit(render({ ...VALID, title: '   ' }).el).disabled).toBe(true);
    act(() => root!.unmount());
    container!.remove();
    expect(submit(render({ ...VALID, body: '\n ' }).el).disabled).toBe(true);
  });

  it('disables submit past the title limit and accepts exactly the limit', () => {
    const limit = 'a'.repeat(MEMORY_TITLE_MAX_CHARS);
    const { el } = render({ ...VALID, title: limit });
    expect(submit(el).disabled).toBe(false);
    type(titleField(el), `${limit}a`);
    expect(submit(el).disabled).toBe(true);
  });

  it('counts the note in UTF-8 bytes and disables submit past the byte limit', () => {
    const { el } = render({ ...VALID, body: 'é' });
    expect(
      el.querySelector('[data-slot="memory-body-bytes"]')!.textContent,
    ).toBe(`2 / ${MEMORY_BODY_MAX_BYTES} bytes`);
    type(bodyField(el), 'é'.repeat(MEMORY_BODY_MAX_BYTES / 2));
    expect(submit(el).disabled).toBe(false);
    type(bodyField(el), `${'é'.repeat(MEMORY_BODY_MAX_BYTES / 2)}a`);
    expect(submit(el).disabled).toBe(true);
    expect(
      el.querySelector('[data-slot="memory-body-bytes"]')!.textContent,
    ).toBe(`${MEMORY_BODY_MAX_BYTES + 1} / ${MEMORY_BODY_MAX_BYTES} bytes`);
  });

  it('submits on Enter in the title, but not while submit is disabled', () => {
    const filled = render(VALID);
    press(titleField(filled.el), 'Enter');
    expect(filled.spies.onSubmit).toHaveBeenCalledTimes(1);
    act(() => root!.unmount());
    container!.remove();
    const blank = render({ ...VALID, title: '' });
    press(titleField(blank.el), 'Enter');
    expect(blank.spies.onSubmit).not.toHaveBeenCalled();
  });

  it('cancels on Escape and on the Cancel button', () => {
    const { el, spies } = render(VALID);
    press(titleField(el), 'Escape');
    expect(spies.onCancel).toHaveBeenCalledTimes(1);
    act(() => cancel(el).click());
    expect(spies.onCancel).toHaveBeenCalledTimes(2);
  });

  it('reports the typed title and note through onChange', () => {
    const { el, spies } = render(VALID);
    type(titleField(el), 'New title');
    type(bodyField(el), 'New note');
    expect(spies.latest.value).toMatchObject({
      title: 'New title',
      body: 'New note',
    });
  });

  it('offers the four memory types and reports the chosen one', () => {
    const { el, spies } = render(VALID);
    act(() => {
      el.querySelectorAll<HTMLElement>('[data-menu-trigger]')[0]!.click();
    });
    expect(
      [...el.querySelectorAll('[role="option"]')].map((o) => o.textContent),
    ).toEqual(['User', 'Feedback', 'Project', 'Reference']);
    act(() => {
      el.querySelectorAll<HTMLElement>('[role="option"]')[2]!.click();
    });
    expect(spies.latest.value.type).toBe('project');
  });

  it('maps Global to a null project and a project to its id', () => {
    const { el, spies } = render({ ...VALID, projectId: 'project-billing' });
    pick(el, 1, 'Global');
    expect(spies.latest.value.projectId).toBeNull();
    pick(el, 1, 'Website');
    expect(spies.latest.value.projectId).toBe('project-website');
  });

  it('shows the error it is given', () => {
    const { el } = render(VALID, { error: 'Title already taken' });
    expect(el.querySelector('[role="alert"]')!.textContent).toBe(
      'Title already taken',
    );
  });
});
