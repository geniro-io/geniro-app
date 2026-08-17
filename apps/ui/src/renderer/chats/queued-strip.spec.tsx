// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { QueuedStrip, type QueuedStripMessage } from './queued-strip';

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

function rerender(element: React.ReactElement): void {
  act(() => {
    root!.render(element);
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

const message = (
  id: string,
  text: string,
  images: readonly unknown[] = [],
): QueuedStripMessage => ({ id, text, images });

const click = (el: Element | null): void => {
  act(() => {
    el!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};

const byLabel = (label: string): HTMLButtonElement | null =>
  container?.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  ) ?? null;

const editor = (position: number): HTMLTextAreaElement | null =>
  container?.querySelector<HTMLTextAreaElement>(
    `textarea[aria-label="Edit queued message ${position}"]`,
  ) ?? null;

/** Type into the open editor and commit with the ⌘/Ctrl+Enter the field takes. */
function typeAndCommit(field: HTMLTextAreaElement, text: string): void {
  act(() => {
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )!.set!;
    setValue.call(field, text);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        metaKey: true,
        bubbles: true,
      }),
    );
  });
}

const noop = (): void => {};

/** Type into the open editor WITHOUT committing, so a control can do it. */
function type(field: HTMLTextAreaElement, text: string): void {
  act(() => {
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )!.set!;
    setValue.call(field, text);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** One of the editor's own controls, by its visible label. */
const control = (text: string): HTMLButtonElement | null =>
  [...(container?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
    (button) => button.textContent?.trim() === text,
  ) ?? null;

describe('QueuedStrip', () => {
  it('renders nothing at all when the queue is empty', () => {
    const el = render(
      <QueuedStrip
        messages={[]}
        steerUnavailableReason={null}
        steerStatus={null}
        onEdit={noop}
        onRemove={noop}
        onSteer={noop}
      />,
    );
    // `firstChild`, not `textContent`: an empty `<div role="group">` also has
    // empty text, so a text assertion passes with the early return deleted.
    expect(el.firstChild).toBeNull();
  });

  it('an empty edit CANCELS instead of blanking the message', () => {
    // Removal is its own control. Committing an empty string here would wipe
    // the text of an entry that may carry images, and the strip has no way to
    // show — or restore — an attachment whose message body has gone.
    const onEdit = vi.fn();
    render(
      <QueuedStrip
        messages={[message('a', 'keep me', [{}])]}
        steerUnavailableReason={null}
        steerStatus={null}
        onEdit={onEdit}
        onRemove={noop}
        onSteer={noop}
      />,
    );

    click(byLabel('Edit queued message 1'));
    typeAndCommit(editor(1)!, '   ');

    expect(onEdit).not.toHaveBeenCalled();
    expect(container!.textContent).toContain('keep me');
  });

  it('closes the editor when the row being edited leaves the queue', () => {
    // The queue drains on its own, so the row under the cursor can be sent out
    // from under it. A draft left open would then commit into whatever entry
    // took its place.
    const first = message('a', 'going out');
    const second = message('b', 'still waiting');
    const props = {
      steerUnavailableReason: null,
      steerStatus: null,
      onEdit: noop,
      onRemove: noop,
      onSteer: noop,
    };
    render(<QueuedStrip messages={[first, second]} {...props} />);

    click(byLabel('Edit queued message 1'));
    expect(editor(1)).not.toBeNull();

    rerender(<QueuedStrip messages={[second]} {...props} />);
    expect(editor(1)).toBeNull();

    // THIS is the assertion that discriminates. While the row is absent no row
    // matches `editingId` at all, so the check above passes with the cleanup
    // effect deleted — it was a false pin. Bringing the row back is what
    // exposes a stale `editingId`: without the effect it is still 'a', and the
    // restored row re-opens its editor over a draft the user abandoned.
    rerender(<QueuedStrip messages={[first, second]} {...props} />);
    expect(editor(1)).toBeNull();
  });

  it('keeps the editor open when a DIFFERENT row leaves the queue', () => {
    // The other half, and the reason this keys on the id rather than on
    // `messages.length`: a length check cannot tell "your row went out" from
    // "somebody else's did", so it threw away a draft the user was still
    // typing every time the queue moved at all.
    const first = message('a', 'being edited');
    const second = message('b', 'unrelated');
    const props = {
      steerUnavailableReason: null,
      steerStatus: null,
      onEdit: noop,
      onRemove: noop,
      onSteer: noop,
    };
    render(<QueuedStrip messages={[first, second]} {...props} />);

    click(byLabel('Edit queued message 1'));
    expect(editor(1)).not.toBeNull();

    rerender(<QueuedStrip messages={[first]} {...props} />);
    expect(editor(1)).not.toBeNull();
  });

  it('says “sends next” on the head alone', () => {
    // An earlier strip told every row it was next, which on a three-deep queue
    // was true of exactly one of them.
    const el = render(
      <QueuedStrip
        messages={[
          message('a', 'first'),
          message('b', 'second'),
          message('c', 'third'),
        ]}
        steerUnavailableReason={null}
        steerStatus={null}
        onEdit={noop}
        onRemove={noop}
        onSteer={noop}
      />,
    );
    expect(el.textContent?.match(/sends next/g)).toHaveLength(1);
  });

  it('reports the message ID back, never its position', () => {
    // The queue shifts underneath these controls while a send is in flight, so
    // a position captured at render time addresses somebody else's message by
    // the time it is clicked.
    const onRemove = vi.fn();
    const onSteer = vi.fn();
    const onEdit = vi.fn();
    render(
      <QueuedStrip
        messages={[message('id-a', 'first'), message('id-b', 'second')]}
        steerUnavailableReason={null}
        steerStatus={null}
        onEdit={onEdit}
        onRemove={onRemove}
        onSteer={onSteer}
      />,
    );

    click(byLabel('Remove queued message 2'));
    expect(onRemove).toHaveBeenCalledWith('id-b');

    click(byLabel('Send queued message 2 now'));
    expect(onSteer).toHaveBeenCalledWith('id-b');

    click(byLabel('Edit queued message 2'));
    typeAndCommit(editor(2)!, 'rewritten');
    expect(onEdit).toHaveBeenCalledWith('id-b', 'rewritten');
  });

  it('a bare Enter inserts a newline instead of committing', () => {
    // The reason the field became a Textarea at all. Note that every OTHER
    // commit in this suite dispatches Enter WITH metaKey, and a reverted guard
    // (`if (event.key === 'Enter')`) still matches those — so all of them stay
    // green while a plain Enter commits again and the newline the user was
    // typing is swallowed. Only this test discriminates.
    const onEdit = vi.fn();
    render(
      <QueuedStrip
        messages={[message('a', 'one line')]}
        steerUnavailableReason={null}
        steerStatus={null}
        onEdit={onEdit}
        onRemove={noop}
        onSteer={noop}
      />,
    );

    click(byLabel('Edit queued message 1'));
    const field = editor(1)!;
    act(() => {
      field.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });

    expect(onEdit).not.toHaveBeenCalled();
    expect(editor(1)).not.toBeNull();
  });

  it('keeps a multi-line rewrite intact', () => {
    // The field was an `<input type=text>`, whose HTML value sanitization
    // strips newlines — and a queued message is a composer prompt.
    const onEdit = vi.fn();
    render(
      <QueuedStrip
        messages={[message('a', 'one line')]}
        steerUnavailableReason={null}
        steerStatus={null}
        onEdit={onEdit}
        onRemove={noop}
        onSteer={noop}
      />,
    );

    click(byLabel('Edit queued message 1'));
    typeAndCommit(editor(1)!, 'line one\nline two');

    expect(onEdit).toHaveBeenCalledWith('a', 'line one\nline two');
  });

  it('leaves Steer reachable when the CLI has no mid-turn channel', () => {
    // `aria-disabled`, not `disabled`: the shared Button carries
    // `disabled:pointer-events-none`, so a truly disabled control never fires
    // the hover that renders `title` — the ONLY place this sentence appears —
    // and drops out of the tab order as well.
    const onSteer = vi.fn();
    render(
      <QueuedStrip
        messages={[message('a', 'urgent')]}
        steerUnavailableReason="cursor-agent takes one prompt per turn"
        steerStatus={null}
        onEdit={noop}
        onRemove={noop}
        onSteer={onSteer}
      />,
    );

    const steer = byLabel('Send queued message 1 now')!;
    expect(steer.getAttribute('aria-disabled')).toBe('true');
    expect(steer.disabled).toBe(false);
    expect(steer.title).toContain('one prompt per turn');

    click(steer);
    expect(onSteer).not.toHaveBeenCalled();
  });

  it('says the message is on its way while its Send-now is in flight', () => {
    // The press used to change nothing at all until the POST resolved, which
    // is how the control came to be reported as doing nothing.
    const el = render(
      <QueuedStrip
        messages={[message('a', 'urgent')]}
        steerUnavailableReason={null}
        steerStatus={{ id: 'a', state: 'sending' }}
        onEdit={noop}
        onRemove={noop}
        onSteer={noop}
      />,
    );
    expect(el.textContent).toContain('sending…');
  });

  it('says the message is still queued when the run would not take it', () => {
    // A RUN_BUSY is deliberately NOT an error banner — the message goes out
    // when the turn ends. It is still an outcome, and the row is where it goes.
    const el = render(
      <QueuedStrip
        messages={[message('a', 'urgent')]}
        steerUnavailableReason={null}
        steerStatus={{ id: 'a', state: 'held' }}
        onEdit={noop}
        onRemove={noop}
        onSteer={noop}
      />,
    );
    expect(el.textContent).toContain('still queued');
    expect(
      el.querySelector('[title*="goes out when this turn ends"]'),
    ).not.toBeNull();
  });

  it('reports the outcome on the steered row alone', () => {
    const el = render(
      <QueuedStrip
        messages={[message('a', 'first'), message('b', 'second')]}
        steerUnavailableReason={null}
        steerStatus={{ id: 'b', state: 'held' }}
        onEdit={noop}
        onRemove={noop}
        onSteer={noop}
      />,
    );
    const rows = el.querySelectorAll('[role="group"] > div');
    expect(rows[0]!.textContent).toContain('sends next');
    expect(rows[0]!.textContent).not.toContain('still queued');
    expect(rows[1]!.textContent).toContain('still queued');
  });

  it('refuses a second Send-now while the first is still in flight', () => {
    // Two POSTs of one queued message deliver it to the agent twice — the
    // defect the id keying fixed on the drain's path, reachable from here.
    const onSteer = vi.fn();
    render(
      <QueuedStrip
        messages={[message('a', 'urgent')]}
        steerUnavailableReason={null}
        steerStatus={{ id: 'a', state: 'sending' }}
        onEdit={noop}
        onRemove={noop}
        onSteer={onSteer}
      />,
    );

    const steer = byLabel('Send queued message 1 now')!;
    expect(steer.getAttribute('aria-disabled')).toBe('true');
    click(steer);
    expect(onSteer).not.toHaveBeenCalled();
  });

  it('still offers Send-now on a row whose outcome is held', () => {
    // `held` is not a dead end: the user may press again, and a turn that has
    // since settled will take it.
    const onSteer = vi.fn();
    render(
      <QueuedStrip
        messages={[message('a', 'urgent')]}
        steerUnavailableReason={null}
        steerStatus={{ id: 'a', state: 'held' }}
        onEdit={noop}
        onRemove={noop}
        onSteer={onSteer}
      />,
    );

    click(byLabel('Send queued message 1 now'));
    expect(onSteer).toHaveBeenCalledWith('a');
  });

  it('names the queue for assistive tech with a role that can carry the name', () => {
    // ARIA ignores an accessible name on a generic element, so the label the
    // strip already set was reaching nobody.
    const el = render(
      <QueuedStrip
        messages={[message('a', 'waiting')]}
        steerUnavailableReason={null}
        steerStatus={null}
        onEdit={noop}
        onRemove={noop}
        onSteer={noop}
      />,
    );
    const group = el.querySelector('[aria-label="Queued messages"]')!;
    expect(group.getAttribute('role')).toBe('group');
  });
});

describe('QueuedStrip — the editor is a block, with its own controls', () => {
  const open = (onEdit: (id: string, text: string) => void): void => {
    render(
      <QueuedStrip
        messages={[message('q1', 'first')]}
        steerUnavailableReason={null}
        steerStatus={null}
        onEdit={onEdit}
        onRemove={noop}
        onSteer={noop}
      />,
    );
    click(byLabel('Edit queued message 1'));
  };

  it('opens a multi-line field rather than a one-line slot', () => {
    // The reported defect: what a composer prompt was edited in was a strip
    // barely taller than its own border. `rows` is the property that decides
    // that, so it is what this asserts.
    open(noop);

    expect(editor(1)!.rows).toBeGreaterThanOrEqual(3);
  });

  it('Save commits the rewrite', () => {
    const onEdit = vi.fn();
    open(onEdit);

    type(editor(1)!, 'rewritten');
    click(control('Save'));

    expect(onEdit).toHaveBeenCalledWith('q1', 'rewritten');
    expect(editor(1)).toBeNull();
  });

  it('Cancel discards it', () => {
    const onEdit = vi.fn();
    open(onEdit);

    type(editor(1)!, 'rewritten');
    click(control('Cancel'));

    expect(onEdit).not.toHaveBeenCalled();
    expect(editor(1)).toBeNull();
  });

  it('does NOT commit on blur, which is what makes Cancel possible', () => {
    // Blur-to-commit and a visible Cancel cannot coexist: clicking Cancel
    // blurs the field first, so the draft being discarded would be saved on
    // the way out. This fails the moment the blur handler comes back.
    const onEdit = vi.fn();
    open(onEdit);

    type(editor(1)!, 'rewritten');
    act(() => {
      editor(1)!.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
    });

    expect(onEdit).not.toHaveBeenCalled();
    expect(editor(1)).not.toBeNull();
  });
});
