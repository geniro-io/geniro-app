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

describe('QueuedStrip', () => {
  it('renders nothing at all when the queue is empty', () => {
    const el = render(
      <QueuedStrip
        messages={[]}
        steerUnavailableReason={null}
        onEdit={noop}
        onRemove={noop}
        onSteer={noop}
      />,
    );
    expect(el.textContent).toBe('');
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
      onEdit: noop,
      onRemove: noop,
      onSteer: noop,
    };
    render(<QueuedStrip messages={[first, second]} {...props} />);

    click(byLabel('Edit queued message 1'));
    expect(editor(1)).not.toBeNull();

    rerender(<QueuedStrip messages={[second]} {...props} />);
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

  it('keeps a multi-line rewrite intact', () => {
    // The field was an `<input type=text>`, whose HTML value sanitization
    // strips newlines — and a queued message is a composer prompt.
    const onEdit = vi.fn();
    render(
      <QueuedStrip
        messages={[message('a', 'one line')]}
        steerUnavailableReason={null}
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

  it('names the queue for assistive tech with a role that can carry the name', () => {
    // ARIA ignores an accessible name on a generic element, so the label the
    // strip already set was reaching nobody.
    const el = render(
      <QueuedStrip
        messages={[message('a', 'waiting')]}
        steerUnavailableReason={null}
        onEdit={noop}
        onRemove={noop}
        onSteer={noop}
      />,
    );
    const group = el.querySelector('[aria-label="Queued messages"]')!;
    expect(group.getAttribute('role')).toBe('group');
  });
});
