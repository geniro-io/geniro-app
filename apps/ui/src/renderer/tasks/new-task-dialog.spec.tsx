// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPreloadStub } from '../__fixtures__/preload-stub';
import {
  type NewTaskAttachments,
  NewTaskDialog,
  type NewTaskInput,
} from './new-task-dialog';
import type { TaskFieldsContext } from './task-fields';

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

/** A board pointed at claude, in a folder, with nothing else pinned. */
const context = (over: Partial<TaskFieldsContext> = {}): TaskFieldsContext => ({
  project: {
    target: 'claude',
    runConfig: { model: null, effort: null, approval: null },
    folder: '/repo',
  },
  workflows: [],
  cliDetections: null,
  agentsApi: null,
  capabilitiesApi: null,
  ...over,
});

type CreateHandler = (
  input: NewTaskInput,
  attachments: NewTaskAttachments,
) => void;

function open(over: Partial<React.ComponentProps<typeof NewTaskDialog>> = {}): {
  onCreate: ReturnType<typeof vi.fn<CreateHandler>>;
} {
  const onCreate = vi.fn<CreateHandler>();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <NewTaskDialog
        open
        onClose={vi.fn()}
        onCreate={onCreate}
        context={context()}
        {...over}
      />,
    );
  });
  return { onCreate };
}

const typeTitle = (text: string): void => {
  const title = document.body.querySelector(
    '#new-task-title',
  ) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set;
  act(() => {
    setter?.call(title, text);
    title.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

/** One property row, found the way a reader finds it: by the name beside it. */
const row = (name: string): HTMLElement => {
  const label = [
    ...document.body.querySelectorAll('[data-slot="new-task"] span'),
  ].find((node) => node.textContent === name);
  return label?.parentElement as HTMLElement;
};

const submit = (): void => {
  const button = [...document.body.querySelectorAll('button')].find(
    (node) => node.textContent === 'Add task',
  ) as HTMLButtonElement;
  act(() => {
    button.click();
  });
};

describe('the properties a draft carries', () => {
  it('draws the panel’s own property rows', () => {
    // The report in one assertion: the dialog was a title, a description and a
    // folder path, so a card could not be given a status, a priority, a due
    // date, labels or an agent until it existed. Named rows, because the names
    // ARE the form — `PropertyRow` renders each one beside its control.
    open();

    const names = [
      ...document.body.querySelectorAll('[data-slot="new-task"] span'),
    ].map((node) => node.textContent);
    expect(names).toEqual(
      expect.arrayContaining([
        'Status',
        'Priority',
        'Due',
        'Labels',
        'Agent',
        'Folder',
      ]),
    );
  });

  it('starts in the column whose + was pressed', () => {
    open({ status: 'in_review' });

    const trigger = document.body.querySelector(
      '[data-menu-trigger][aria-label="Status"]',
    ) as HTMLButtonElement;
    expect(trigger.textContent).toContain('In review');
  });

  it('shows the project’s agent as inherited, and sends none of its own', () => {
    // A draft that names nothing inherits, exactly as a saved card does — so
    // the row states the project's answer with the `project` tag, and create
    // is sent no `agentKind`, which is what makes the project the default.
    const { onCreate } = open();

    // The ROW, not the page: `project` also tags the inherited folder a few
    // rows down, so a body-wide search would pass with the Agent row blank.
    expect(row('Agent').textContent).toContain('claude');
    expect(row('Agent').textContent).toContain('project');

    typeTitle('Inherits everything');
    submit();

    const sent = onCreate.mock.calls[0]?.[0] as NewTaskInput;
    expect('agentKind' in sent).toBe(false);
    expect('workflowSlug' in sent).toBe(false);
    expect('folder' in sent).toBe(false);
  });

  it('refuses to create a card with no title', () => {
    open();

    const button = [...document.body.querySelectorAll('button')].find(
      (node) => node.textContent === 'Add task',
    ) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('forgets an abandoned draft on the next open', () => {
    // Visibility-toggled rather than remounted, so Escape and a backdrop click
    // leave the draft standing unless opening clears it.
    open();
    typeTitle('Half a thought');

    act(() => {
      root!.render(
        <NewTaskDialog
          open={false}
          onClose={vi.fn()}
          onCreate={vi.fn()}
          context={context()}
        />,
      );
    });
    act(() => {
      root!.render(
        <NewTaskDialog
          open
          onClose={vi.fn()}
          onCreate={vi.fn()}
          context={context()}
        />,
      );
    });

    expect(
      (document.body.querySelector('#new-task-title') as HTMLInputElement)
        .value,
    ).toBe('');
  });
});

/**
 * What a draft can hold that the create route cannot take.
 *
 * REPORTED as "i cant add images to task when i just create task - only when
 * edit". Both a picture and a file are bound to a card by its id, so the
 * dialog stages them and hands them over beside the card's fields.
 */
describe('what a draft stages for the card it becomes', () => {
  const description = (): HTMLTextAreaElement =>
    document.body.querySelector('#new-task-description') as HTMLTextAreaElement;

  /** Write the field the way typing does — the controlled value reads `input`. */
  const setDescription = (text: string): void => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )?.set;
    act(() => {
      setter?.call(description(), text);
      description().dispatchEvent(new Event('input', { bubbles: true }));
    });
  };

  /**
   * jsdom has no `execCommand`; this one does what the browser's does here —
   * writes the text into the focused field and fires `input`.
   */
  const installInsertText = (): void => {
    document.execCommand = ((_command: string, _ui: boolean, text: string) => {
      const field = document.activeElement as HTMLTextAreaElement;
      setDescription(field.value + text);
      return true;
    }) as unknown as typeof document.execCommand;
  };

  const pasteScreenshot = (): void => {
    const shot = new File([new Uint8Array([1, 2, 3])], 'shot.png', {
      type: 'image/png',
    });
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: { files: [shot], types: ['Files'] },
    });
    description().focus();
    act(() => {
      description().dispatchEvent(event);
    });
  };

  it('stages a pasted screenshot where it was pasted, and hands it over with the card', () => {
    installInsertText();
    const { onCreate } = open();

    pasteScreenshot();

    // The reference is in the text at once, and the dialog says what it is.
    expect(description().value).toBe('![shot.png](staged-image:1)');
    expect(
      document.body.querySelector('[data-slot="new-task-staged"]')?.textContent,
    ).toContain('1 picture is attached when the task is created');

    typeTitle('With a screenshot');
    submit();

    const [input, staged] = onCreate.mock.calls[0]!;
    expect(input.description).toBe('![shot.png](staged-image:1)');
    expect(staged.images.map((image) => image.ref)).toEqual(['staged-image:1']);
  });

  it('drops a picture whose reference was deleted before Add', () => {
    // Deleting the reference is how a user takes a pasted picture back out,
    // and a picture nobody asked for must not be written to disk.
    installInsertText();
    const { onCreate } = open();

    pasteScreenshot();
    setDescription('Changed my mind');
    expect(
      document.body.querySelector('[data-slot="new-task-staged"]'),
    ).toBeNull();

    typeTitle('No screenshot after all');
    submit();

    expect(onCreate.mock.calls[0]![1].images).toEqual([]);
  });

  it('stages picked files on the panel’s own Files row', async () => {
    window.geniro = createPreloadStub({
      pickTaskFiles: vi.fn(async () => ['/docs/spec.pdf']),
    });
    const { onCreate } = open();

    const attach = [...document.body.querySelectorAll('button')].find(
      (node) => node.textContent === 'Attach files',
    ) as HTMLButtonElement;
    await act(async () => {
      attach.click();
    });

    expect(row('Files').textContent).toContain('spec.pdf');

    typeTitle('With a file');
    submit();

    expect(onCreate.mock.calls[0]![1]).toEqual({
      images: [],
      files: ['/docs/spec.pdf'],
    });
  });
});
