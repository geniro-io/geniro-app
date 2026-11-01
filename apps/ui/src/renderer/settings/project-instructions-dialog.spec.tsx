// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { aProject } from '../tasks/__tests__/fixtures';
import { ProjectInstructionsDialog } from './project-instructions-dialog';

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

async function render(
  project: ReturnType<typeof aProject> | null,
  handlers: { onSave?: () => void; onClose?: () => void } = {},
): Promise<{
  onSave: ReturnType<typeof vi.fn>;
  onClose: ReturnType<typeof vi.fn>;
}> {
  const onSave = vi.fn(handlers.onSave);
  const onClose = vi.fn(handlers.onClose);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <ProjectInstructionsDialog
        project={project}
        onSave={onSave}
        onClose={onClose}
      />,
    );
  });
  return { onSave, onClose };
}

const setValue = (node: HTMLTextAreaElement, value: string): void => {
  Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    'value',
  )?.set?.call(node, value);
  node.dispatchEvent(new Event('input', { bubbles: true }));
};

const field = (id: string): HTMLTextAreaElement =>
  document.body.querySelector(`#${id}`) as HTMLTextAreaElement;

const button = (text: string): HTMLButtonElement =>
  [...document.body.querySelectorAll('button')].find(
    (node) => (node.textContent ?? '').trim() === text,
  ) as HTMLButtonElement;

describe('ProjectInstructionsDialog', () => {
  it('starts from the project’s own description and instructions', async () => {
    await render(
      aProject({ description: 'Billing API', instructions: 'Use pnpm.' }),
    );

    expect(field('project-description').value).toBe('Billing API');
    expect(field('project-instructions').value).toBe('Use pnpm.');
  });

  it('saves the edited fields trimmed, as one patch for the project, and closes', async () => {
    const { onSave, onClose } = await render(
      aProject({ id: 'p9', description: 'Billing API', instructions: null }),
    );

    await act(async () => {
      setValue(field('project-description'), '  The invoicing service.  ');
    });
    await act(async () => {
      setValue(field('project-instructions'), '\nNever touch /legacy.\n');
    });
    await act(async () => {
      button('Save').click();
    });

    expect(onSave).toHaveBeenCalledWith('p9', {
      description: 'The invoicing service.',
      instructions: 'Never touch /legacy.',
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('sends a cleared or blank field as null, which clears it on the daemon', async () => {
    const { onSave } = await render(
      aProject({ id: 'p9', description: 'Billing API', instructions: 'x' }),
    );

    await act(async () => {
      setValue(field('project-description'), '');
    });
    await act(async () => {
      setValue(field('project-instructions'), '  \n ');
    });
    await act(async () => {
      button('Save').click();
    });

    expect(onSave).toHaveBeenCalledWith('p9', {
      description: null,
      instructions: null,
    });
  });

  it('discards the edits on Cancel', async () => {
    const { onSave, onClose } = await render(
      aProject({ description: 'Billing API' }),
    );

    await act(async () => {
      setValue(field('project-description'), 'Something else');
    });
    await act(async () => {
      button('Cancel').click();
    });

    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders nothing while no project is being edited', async () => {
    await render(null);

    expect(document.body.querySelector('#project-description')).toBeNull();
  });
});
