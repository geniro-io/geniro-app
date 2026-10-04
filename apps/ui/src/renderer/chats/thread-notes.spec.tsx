// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The real editor is far heavier than this spec needs — a controlled textarea.
vi.mock('../components/ui/md-editor', () => ({
  MdEditor: ({
    value,
    onChange,
  }: {
    value: string;
    onChange?: (next: string) => void;
  }) => (
    <textarea
      data-testid="md-editor"
      value={value}
      onChange={(event) => onChange?.(event.target.value)}
    />
  ),
}));

import {
  MAX_THREAD_NOTES_LENGTH,
  notesPreview,
  ThreadNotes,
} from './thread-notes';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render(element: React.ReactElement): HTMLTextAreaElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(element);
  });
  return container.querySelector('textarea')!;
}

function rerender(element: React.ReactElement): void {
  act(() => {
    root!.render(element);
  });
}

function type(field: HTMLTextAreaElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
});

describe('ThreadNotes', () => {
  it('shows the stored notes and saves an edit once typing pauses', async () => {
    const onSave = vi.fn(async () => {});
    const field = render(<ThreadNotes notes="first" onSave={onSave} />);
    expect(field.value).toBe('first');

    type(field, 'first draft');
    type(field, 'first draft, revised');
    expect(onSave).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith('first draft, revised');
  });

  it('saves a pending edit when it is unmounted before the pause', () => {
    const onSave = vi.fn(async () => {});
    const field = render(<ThreadNotes notes={null} onSave={onSave} />);
    type(field, 'left mid-sentence');

    act(() => {
      root!.unmount();
    });
    root = null;
    expect(onSave).toHaveBeenCalledWith('left mid-sentence');
  });

  it('adopts notes changed elsewhere while the field is idle', () => {
    const onSave = vi.fn(async () => {});
    const field = render(<ThreadNotes notes="old" onSave={onSave} />);

    rerender(<ThreadNotes notes="written in another window" onSave={onSave} />);
    expect(field.value).toBe('written in another window');
  });

  it('takes changes from elsewhere again once its own edit is saved', async () => {
    const onSave = vi.fn(async () => {});
    const field = render(<ThreadNotes notes="a" onSave={onSave} />);
    type(field, 'mine');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    expect(onSave).toHaveBeenCalledWith('mine');

    rerender(<ThreadNotes notes="theirs" onSave={onSave} />);
    expect(field.value).toBe('theirs');
  });

  it('shows no error when an OLDER save fails after a newer one succeeded', async () => {
    let refuseFirst: (err: Error) => void = () => {};
    const onSave = vi
      .fn<(text: string) => Promise<void>>()
      .mockImplementationOnce(
        () =>
          new Promise<void>((_, reject) => {
            refuseFirst = reject;
          }),
      )
      .mockResolvedValue(undefined);
    const field = render(<ThreadNotes notes={null} onSave={onSave} />);
    type(field, 'A');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    type(field, 'AB');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });

    await act(async () => {
      refuseFirst(new Error('late refusal'));
      await Promise.resolve();
    });
    expect(container!.querySelector('[role="alert"]')).toBeNull();
  });

  it('keeps the error when an OLDER save succeeds after a newer one failed', async () => {
    let acceptFirst: () => void = () => {};
    const onSave = vi
      .fn<(text: string) => Promise<void>>()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            acceptFirst = resolve;
          }),
      )
      .mockRejectedValueOnce(new Error('daemon restarting'));
    const field = render(<ThreadNotes notes={null} onSave={onSave} />);
    type(field, 'A');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    type(field, 'AB');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    expect(container!.querySelector('[role="alert"]')).not.toBeNull();

    await act(async () => {
      acceptFirst();
      await Promise.resolve();
    });
    expect(container!.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('edits in the expanded editor popup and saves what is written there', async () => {
    const onSave = vi.fn(async () => {});
    const field = render(<ThreadNotes notes="short" onSave={onSave} />);
    act(() => {
      container!
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Expand Thread notes"]',
        )!
        .click();
    });
    const popup = container!.querySelector<HTMLTextAreaElement>(
      '[data-testid="md-editor"]',
    )!;
    expect(popup.value).toBe('short');
    type(popup, 'a much longer note\nwritten in the popup');
    act(() => {
      [...container!.querySelectorAll<HTMLButtonElement>('button')]
        .find((el) => el.textContent?.trim() === 'Save')!
        .click();
    });

    expect(field.value).toBe('a much longer note\nwritten in the popup');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    expect(onSave).toHaveBeenCalledWith(
      'a much longer note\nwritten in the popup',
    );
  });

  it('keeps an unfocused edit while its save is still pending', () => {
    const onSave = vi.fn(async () => {});
    const field = render(<ThreadNotes notes="a" onSave={onSave} />);
    // Never focused: only the pending write protects the text.
    type(field, 'abc');

    rerender(<ThreadNotes notes="ab" onSave={onSave} />);
    expect(field.value).toBe('abc');
  });

  it('ignores a change from elsewhere while the field is focused, even with nothing pending', async () => {
    const onSave = vi.fn(async () => {});
    const field = render(<ThreadNotes notes="a" onSave={onSave} />);
    act(() => {
      field.focus();
    });
    type(field, 'mine');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    // Saved, so only the focus is left to protect the text.
    expect(onSave).toHaveBeenCalledWith('mine');

    rerender(<ThreadNotes notes="theirs" onSave={onSave} />);
    expect(field.value).toBe('mine');
  });

  it('retries a refused save when the field goes away', async () => {
    const onSave = vi
      .fn<(text: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('daemon restarting'))
      .mockResolvedValue(undefined);
    const field = render(<ThreadNotes notes={null} onSave={onSave} />);
    type(field, 'do not lose me');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    expect(onSave).toHaveBeenCalledTimes(1);

    act(() => {
      root!.unmount();
    });
    root = null;
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(onSave).toHaveBeenLastCalledWith('do not lose me');
  });

  it('writes the NEWER edit, not the refused one, when leaving after typing again', async () => {
    const onSave = vi
      .fn<(text: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('daemon restarting'))
      .mockResolvedValue(undefined);
    const field = render(<ThreadNotes notes={null} onSave={onSave} />);
    type(field, 'A');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    type(field, 'AB');

    act(() => {
      root!.unmount();
    });
    root = null;
    expect(onSave.mock.calls.map(([text]) => text)).toEqual(['A', 'AB']);
  });

  it('retries a save refused only after the field had gone', async () => {
    let refuse: (err: Error) => void = () => {};
    const onSave = vi
      .fn<(text: string) => Promise<void>>()
      .mockImplementationOnce(
        () =>
          new Promise<void>((_, reject) => {
            refuse = reject;
          }),
      )
      .mockResolvedValue(undefined);
    const field = render(<ThreadNotes notes={null} onSave={onSave} />);
    type(field, 'in flight');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });

    act(() => {
      root!.unmount();
    });
    root = null;
    await act(async () => {
      refuse(new Error('daemon restarting'));
      await Promise.resolve();
    });
    expect(onSave.mock.calls.map(([text]) => text)).toEqual([
      'in flight',
      'in flight',
    ]);
  });

  it('caps the field at the daemon’s notes limit', () => {
    const field = render(<ThreadNotes notes={null} onSave={vi.fn()} />);
    expect(field.maxLength).toBe(10_000);
    // Read off the daemon's own file: the generated client does not carry the
    // schema's bound, so nothing else would notice the two drifting apart.
    const source = readFileSync(
      join(__dirname, '../../../../daemon/src/v1/agents/chat.types.ts'),
      'utf8',
    );
    const daemon = /export const MAX_RUN_NOTES_LENGTH = ([\d_]+);/.exec(
      source,
    )?.[1];
    expect(Number(daemon?.replaceAll('_', ''))).toBe(MAX_THREAD_NOTES_LENGTH);
  });

  it('keeps the text and says so when a save is refused', async () => {
    const onSave = vi.fn(async () => {
      throw new Error('daemon PATCH failed (500)');
    });
    const field = render(<ThreadNotes notes={null} onSave={onSave} />);
    type(field, 'keep me');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    expect(field.value).toBe('keep me');
    expect(container!.querySelector('[role="alert"]')?.textContent).toContain(
      'could not be saved',
    );
  });
});

describe('notesPreview', () => {
  it('is null for notes that hold nothing', () => {
    expect(notesPreview(null)).toBeNull();
    expect(notesPreview(undefined)).toBeNull();
    expect(notesPreview(' \n\t ')).toBeNull();
  });

  it('trims the text and keeps its line breaks', () => {
    expect(notesPreview('\n  step one\nstep two  \n')).toBe(
      'step one\nstep two',
    );
  });

  it('cuts a long note at the limit with an ellipsis', () => {
    const preview = notesPreview('x'.repeat(50), 10);
    expect(preview).toBe(`${'x'.repeat(9)}…`);
  });
});
