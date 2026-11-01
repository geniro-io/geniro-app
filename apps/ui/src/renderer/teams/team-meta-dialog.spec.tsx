// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { settleStageGraphs } from '../__tests__/settle-stage-graphs';
import { stubResizeObserver } from '../__tests__/stub-resize-observer';
import type { TeamMeta } from './team-doc';
import { TeamMetaDialog } from './team-meta-dialog';

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
    initial?: TeamMeta;
    maxActiveTurnsCeiling?: number | null;
    onAskChat?: (hasStages: boolean) => void;
  } = {},
): void {
  act(() => {
    root.render(
      <TeamMetaDialog
        open={props.open ?? true}
        busy={props.busy ?? false}
        error={props.error ?? null}
        title="New team"
        submitLabel="Create"
        busyLabel="Creating…"
        {...(props.initial ? { initial: props.initial } : {})}
        maxActiveTurnsCeiling={
          props.maxActiveTurnsCeiling === undefined
            ? 8
            : props.maxActiveTurnsCeiling
        }
        members={[{ id: 'coder', name: 'Coder' }]}
        onClose={onClose}
        onSubmit={onSubmit}
        {...(props.onAskChat ? { onAskChat: props.onAskChat } : {})}
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
  return container.querySelector<HTMLInputElement>('#team-name')!;
}

function descriptionInput(): HTMLTextAreaElement {
  return container.querySelector<HTMLTextAreaElement>('#team-description')!;
}

function limitSwitch(): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>('#team-limit-turns')!;
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

describe('TeamMetaDialog', () => {
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

  describe('stages', () => {
    const STAGES = [
      {
        id: 'investigate',
        title: 'Investigation',
        goal: 'Cause found',
        next: ['implement', 'fix'],
      },
      { id: 'implement', title: 'Implementation', goal: 'Built' },
      { id: 'fix', title: 'Fix', goal: 'Fixed' },
    ];

    async function graphColumns(): Promise<string[][] | null> {
      stubResizeObserver();
      await settleStageGraphs(container);
      const graph = container.querySelector('[data-slot="stage-graph"]');
      if (graph === null) {
        return null;
      }
      const columns: string[][] = [];
      for (const pill of graph.querySelectorAll<HTMLElement>(
        '[data-slot="stage-pill"]',
      )) {
        (columns[Number(pill.dataset.column)] ??= []).push(
          pill.querySelector('[data-slot="stage-pill-title"]')!.textContent!,
        );
      }
      return columns;
    }

    function emptyState(): string | null {
      return (
        container.querySelector('[data-slot="stages-empty"]')?.textContent ??
        null
      );
    }

    const FORK_COLUMNS = [['Investigation'], ['Implementation', 'Fix']];

    function fillGoal(text: string): void {
      const htmlFor = Array.from(container.querySelectorAll('label')).find(
        (l) => l.textContent === 'Goal',
      )!.htmlFor;
      type(document.getElementById(htmlFor) as HTMLInputElement, text);
    }

    function pressText(label: string): void {
      act(() => {
        Array.from(container.querySelectorAll('button'))
          .find((b) => b.textContent?.trim() === label)!
          .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
    }

    it('says there are none and what stages are, and submits without a stages key', async () => {
      render();
      expect(await graphColumns()).toBeNull();
      expect(emptyState()).toContain('No stages yet');
      expect(emptyState()).toContain('the steps every run walks');
      expect(container.querySelector('[data-slot="stages-count"]')).toBeNull();
      type(nameInput(), 'Team');
      submit();
      expect(onSubmit).toHaveBeenCalledWith({ name: 'Team' });
    });

    it('draws saved stages as the stage graph, a fork split into rows, with a count', async () => {
      render({ initial: { name: 'Team', stages: STAGES } });
      expect(emptyState()).toBeNull();
      expect(await graphColumns()).toEqual(FORK_COLUMNS);
      expect(
        container
          .querySelector('[data-slot="stage-graph-canvas"]')!
          .getAttribute('aria-label'),
      ).toBe('Stages: Investigation → Implementation or Fix');
      expect(
        container.querySelector('[data-slot="stages-count"]')?.textContent,
      ).toBe('3 stages · 1 fork');
      expect(
        container.querySelector('[data-slot="stage-pill"][role="button"]'),
      ).toBeNull();
    });

    it('counts a line with no fork as stages alone', () => {
      render({
        initial: {
          name: 'Team',
          stages: [
            { id: 'a', title: 'A', goal: 'a', next: ['b'] },
            { id: 'b', title: 'B', goal: 'b' },
          ],
        },
      });
      expect(
        container.querySelector('[data-slot="stages-count"]')?.textContent,
      ).toBe('2 stages');
    });

    it('resubmits saved stages untouched', () => {
      render({ initial: { name: 'Team', stages: STAGES } });
      submit();
      expect(onSubmit).toHaveBeenCalledWith({ name: 'Team', stages: STAGES });
    });

    it('opens the stage editor over the form and takes its saved stages', async () => {
      render();
      type(nameInput(), 'Team');
      expect(
        container.querySelector('[data-slot="stage-schema-editor"]'),
      ).toBeNull();

      pressText('Add stages');
      expect(
        container.querySelector('[data-slot="stage-schema-editor"]'),
      ).not.toBeNull();
      pressText('Add stage');
      fillGoal('It works');
      pressText('Done');

      expect(
        container.querySelector('[data-slot="stage-schema-editor"]'),
      ).toBeNull();
      expect(await graphColumns()).toEqual([['Stage 1']]);
      expect(onSubmit).not.toHaveBeenCalled();
      submit();
      expect(onSubmit).toHaveBeenCalledWith({
        name: 'Team',
        stages: [{ id: 'stage-1', title: 'Stage 1', goal: 'It works' }],
      });
    });

    it('leaves the stages alone when the editor is cancelled', async () => {
      render({ initial: { name: 'Team', stages: STAGES } });
      pressText('Edit stages');
      pressText('Add stage');
      pressText('Cancel');
      expect(await graphColumns()).toEqual(FORK_COLUMNS);
      submit();
      expect(onSubmit).toHaveBeenCalledWith({ name: 'Team', stages: STAGES });
    });

    it('drops the stages key when the last stage is deleted', async () => {
      render({
        initial: {
          name: 'Team',
          stages: [{ id: 'only', title: 'Only', goal: 'Done' }],
        },
      });
      pressText('Edit stages');
      act(() => {
        container
          .querySelector<HTMLElement>(
            '[data-slot="stage-row"] [data-menu-trigger]',
          )!
          .click();
      });
      act(() => {
        Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'))
          .find((o) => o.textContent?.includes('Delete'))!
          .click();
      });
      pressText('Done');
      expect(await graphColumns()).toBeNull();
      expect(emptyState()).toContain('No stages yet');
      submit();
      expect(onSubmit).toHaveBeenCalledWith({ name: 'Team' });
    });

    it('keeps the stage edits through a re-render with an equal initial, and resets on reopening', async () => {
      const copy = (): TeamMeta => ({
        name: 'Team',
        stages: STAGES.map((stage) => ({ ...stage })),
      });
      render({ initial: copy() });
      pressText('Edit stages');
      pressText('Add stage');
      fillGoal('Shipped');
      pressText('Done');
      expect((await graphColumns())!.flat()).toHaveLength(4);

      pressText('Edit stages');
      pressText('Add stage');
      render({ initial: copy() });
      expect(
        container.querySelector('[data-slot="stage-schema-editor"]'),
      ).not.toBeNull();
      expect(
        container.querySelectorAll('[data-slot="stage-row"]'),
      ).toHaveLength(5);
      pressText('Cancel');
      expect((await graphColumns())!.flat()).toHaveLength(4);

      render({ open: false, initial: copy() });
      render({ initial: copy() });
      expect(await graphColumns()).toEqual(FORK_COLUMNS);
    });

    it('takes the stages a re-read brought while open, so a later Save does not write the old ones back', async () => {
      render({ initial: { name: 'Team', stages: STAGES } });
      const reread = STAGES.slice(0, 1).map((stage) => ({
        ...stage,
        next: undefined,
      }));
      render({ initial: { name: 'Team', stages: reread } });
      expect((await graphColumns())!.flat()).toHaveLength(1);
    });

    it('does not submit the form from the editor’s buttons', () => {
      render({ initial: { name: 'Team' } });
      pressText('Add stages');
      pressText('Add stage');
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('hands adding stages to the chat, and changing saved ones, without submitting', () => {
      const onAskChat = vi.fn();
      render({ initial: { name: 'Team' }, onAskChat });
      pressText('Add with chat');
      expect(onAskChat).toHaveBeenLastCalledWith(false);

      render({ initial: { name: 'Team', stages: STAGES }, onAskChat });
      pressText('Change with chat');
      expect(onAskChat).toHaveBeenLastCalledWith(true);
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('holds the chat back while the dialog has unsaved changes, which handing over would drop', () => {
      const onAskChat = vi.fn();
      render({ initial: { name: 'Team', stages: STAGES }, onAskChat });
      type(nameInput(), 'Team two');
      const ask = [...container.querySelectorAll('button')].find(
        (b) => b.textContent?.trim() === 'Change with chat',
      )!;
      expect(ask.getAttribute('aria-disabled')).toBe('true');
      expect(ask.title).toContain('Save or cancel your changes first');
      pressText('Change with chat');
      expect(onAskChat).not.toHaveBeenCalled();

      type(nameInput(), 'Team');
      expect(ask.hasAttribute('aria-disabled')).toBe(false);
      pressText('Change with chat');
      expect(onAskChat).toHaveBeenCalledWith(true);
    });

    it('offers no chat where there is none to ask', () => {
      render({ initial: { name: 'Team', stages: STAGES } });
      const labels = [...container.querySelectorAll('button')].map((b) =>
        b.textContent?.trim(),
      );
      expect(labels).not.toContain('Change with chat');
      expect(labels).toContain('Edit stages');
    });
  });
});
