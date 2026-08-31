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

const pressKey = (el: Element, key: string): void => {
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
};

/**
 * Carry `from` over `to` — a `dragstart` on one row followed by a `dragover`
 * on the other.
 *
 * jsdom implements neither `DragEvent` nor `DataTransfer`, so the events are
 * plain bubbling `Event`s with a `dataTransfer` stub attached. That is enough
 * for what is being asserted — React reads the handler off the event's type and
 * the component only calls `setData`/`dropEffect` on it — and the alternative
 * would be asserting nothing about the gesture at all.
 */
const dragOver = (from: Element, to: Element): Event => {
  const dataTransfer = { setData: () => {}, effectAllowed: '', dropEffect: '' };
  const fire = (el: Element, type: string): Event => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
    act(() => {
      el.dispatchEvent(event);
    });
    return event;
  };
  fire(from, 'dragstart');
  // The `dragover` is handed back so a test can read `defaultPrevented` off it,
  // which is the ONE observable that decides whether the browser plays its
  // snap-back animation when the button comes up.
  return fire(to, 'dragover');
};

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

/**
 * Props every test needs and none of them is about. `turnInFlight: true` is
 * the state this strip was written under — a queue exists because a turn is
 * running — so it is what keeps the Send-now assertions below meaning what
 * they meant before the pause was added.
 */
const base = { paused: false, turnInFlight: true, onTogglePause: noop };

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
        {...base}
        messages={[]}
        steerUnavailableReason={null}
        steerStatus={null}
        onEdit={noop}
        onRemove={noop}
        onReorder={() => {}}
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
        {...base}
        messages={[message('a', 'keep me', [{}])]}
        steerUnavailableReason={null}
        steerStatus={null}
        onEdit={onEdit}
        onRemove={noop}
        onReorder={() => {}}
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
      onReorder: noop,
      onSteer: noop,
    };
    render(<QueuedStrip {...base} messages={[first, second]} {...props} />);

    click(byLabel('Edit queued message 1'));
    expect(editor(1)).not.toBeNull();

    rerender(<QueuedStrip {...base} messages={[second]} {...props} />);
    expect(editor(1)).toBeNull();

    // THIS is the assertion that discriminates. While the row is absent no row
    // matches `editingId` at all, so the check above passes with the cleanup
    // effect deleted — it was a false pin. Bringing the row back is what
    // exposes a stale `editingId`: without the effect it is still 'a', and the
    // restored row re-opens its editor over a draft the user abandoned.
    rerender(<QueuedStrip {...base} messages={[first, second]} {...props} />);
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
      onReorder: noop,
      onSteer: noop,
    };
    render(<QueuedStrip {...base} messages={[first, second]} {...props} />);

    click(byLabel('Edit queued message 1'));
    expect(editor(1)).not.toBeNull();

    rerender(<QueuedStrip {...base} messages={[first]} {...props} />);
    expect(editor(1)).not.toBeNull();
  });

  it('says “sends next” on the head alone', () => {
    // An earlier strip told every row it was next, which on a three-deep queue
    // was true of exactly one of them.
    const el = render(
      <QueuedStrip
        {...base}
        messages={[
          message('a', 'first'),
          message('b', 'second'),
          message('c', 'third'),
        ]}
        steerUnavailableReason={null}
        steerStatus={null}
        onEdit={noop}
        onRemove={noop}
        onReorder={() => {}}
        onSteer={noop}
      />,
    );
    expect(el.textContent?.match(/sends next/g)).toHaveLength(1);
  });

  it('reorders by DRAGGING one row over another, reporting both by id', () => {
    // REPORTED as "я хочу иметь возможность drag-and-drop передвигать queue
    // сообщений, чтобы контролировать, какое сообщение следующим отправится
    // первым". The queue drains from the head, so the arrangement was the whole
    // decision and it was frozen at the order things were typed in.
    const onReorder = vi.fn();
    render(
      <QueuedStrip
        {...base}
        messages={[
          message('id-a', 'first'),
          message('id-b', 'second'),
          message('id-c', 'third'),
        ]}
        steerUnavailableReason={null}
        steerStatus={null}
        onEdit={noop}
        onRemove={noop}
        onReorder={onReorder}
        onSteer={noop}
      />,
    );
    const rows = [
      ...container!.querySelectorAll('[data-slot="queued-message"]'),
    ];
    expect(rows).toHaveLength(3);

    dragOver(rows[2]!, rows[0]!);

    // Ids on BOTH sides, like every other control here: the queue drains on its
    // own, so a position captured when the row rendered can address a different
    // message by the time the pointer reaches it.
    expect(onReorder).toHaveBeenCalledWith('id-c', 'id-a');
  });

  it('does not report a drag over the row being dragged', () => {
    // Passing over yourself is not a move, and reporting it would put a
    // `splice` in the caller's queue on every pointer twitch.
    const onReorder = vi.fn();
    render(
      <QueuedStrip
        {...base}
        messages={[message('id-a', 'first'), message('id-b', 'second')]}
        steerUnavailableReason={null}
        steerStatus={null}
        onEdit={noop}
        onRemove={noop}
        onReorder={onReorder}
        onSteer={noop}
      />,
    );
    const rows = [
      ...container!.querySelectorAll('[data-slot="queued-message"]'),
    ];
    dragOver(rows[0]!, rows[0]!);
    expect(onReorder).not.toHaveBeenCalled();
  });

  it('still ACCEPTS the drop over the row being dragged', () => {
    // REPORTED as "wrong animation when i moving message in message queue —
    // it's like jumping back to its position before moving". A drag whose last
    // `dragover` was not prevented is an unsuccessful drop, and the browser
    // answers one by flying the drag image back to where it was picked up.
    //
    // This row is where the gesture almost always ENDS: the list rearranges
    // live under the pointer, so the carried row follows the cursor and is the
    // element under it when the button comes up. Refusing the drop here — which
    // the same-row early return above used to do — made the snap-back fire on
    // essentially every reorder, with the queue itself already correct.
    //
    // `defaultPrevented` is the real observable and the only one: jsdom runs no
    // drag machinery, so the animation cannot be seen here, but it is precisely
    // this flag the browser branches on.
    render(
      <QueuedStrip
        {...base}
        messages={[message('id-a', 'first'), message('id-b', 'second')]}
        steerUnavailableReason={null}
        steerStatus={null}
        onEdit={noop}
        onRemove={noop}
        onReorder={noop}
        onSteer={noop}
      />,
    );
    const rows = [
      ...container!.querySelectorAll('[data-slot="queued-message"]'),
    ];
    expect(dragOver(rows[0]!, rows[0]!).defaultPrevented).toBe(true);
    // And over a DIFFERENT row too, which is the half that always worked.
    expect(dragOver(rows[0]!, rows[1]!).defaultPrevented).toBe(true);
  });

  it('refuses a drag that did not start in the strip', () => {
    // The sidebar's chat rows are draggable too. Accepting one here would take
    // the drop and land it nowhere — so the strip is a drop target only for the
    // gesture it started itself.
    render(
      <QueuedStrip
        {...base}
        messages={[message('id-a', 'first'), message('id-b', 'second')]}
        steerUnavailableReason={null}
        steerStatus={null}
        onEdit={noop}
        onRemove={noop}
        onReorder={noop}
        onSteer={noop}
      />,
    );
    const rows = [
      ...container!.querySelectorAll('[data-slot="queued-message"]'),
    ];
    const event = new Event('dragover', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', {
      value: { setData: () => {}, effectAllowed: '', dropEffect: '' },
    });
    act(() => {
      rows[0]!.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
  });

  it('moves a row with ↑ / ↓ on its grip, and stops at the ends', () => {
    // Dragging is the only other way to reorder, so without this the feature is
    // out of reach of the keyboard entirely.
    const onReorder = vi.fn();
    render(
      <QueuedStrip
        {...base}
        messages={[
          message('id-a', 'first'),
          message('id-b', 'second'),
          message('id-c', 'third'),
        ]}
        steerUnavailableReason={null}
        steerStatus={null}
        onEdit={noop}
        onRemove={noop}
        onReorder={onReorder}
        onSteer={noop}
      />,
    );

    pressKey(byLabel('Reorder queued message 2')!, 'ArrowUp');
    expect(onReorder).toHaveBeenLastCalledWith('id-b', 'id-a');
    pressKey(byLabel('Reorder queued message 2')!, 'ArrowDown');
    expect(onReorder).toHaveBeenLastCalledWith('id-b', 'id-c');

    // The ends have nowhere to go, and reporting a move to a neighbour that is
    // not there would send the row to the far end of the queue instead.
    onReorder.mockClear();
    pressKey(byLabel('Reorder queued message 1')!, 'ArrowUp');
    pressKey(byLabel('Reorder queued message 3')!, 'ArrowDown');
    expect(onReorder).not.toHaveBeenCalled();
  });

  it('cannot be dragged while its own editor is open', () => {
    // `group-header` records the reason: a text field inside a draggable
    // element cannot be selected with the mouse, because the drag starts
    // instead of the selection.
    render(
      <QueuedStrip
        {...base}
        messages={[message('id-a', 'first'), message('id-b', 'second')]}
        steerUnavailableReason={null}
        steerStatus={null}
        onEdit={noop}
        onRemove={noop}
        onReorder={noop}
        onSteer={noop}
      />,
    );
    const rows = (): Element[] => [
      ...container!.querySelectorAll('[data-slot="queued-message"]'),
    ];
    expect(rows()[0]!.getAttribute('draggable')).toBe('true');

    click(byLabel('Edit queued message 1'));

    expect(rows()[0]!.getAttribute('draggable')).toBe('false');
    // …and only that one: the rest of the queue can still be rearranged around
    // the row being written.
    expect(rows()[1]!.getAttribute('draggable')).toBe('true');
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
        {...base}
        messages={[message('id-a', 'first'), message('id-b', 'second')]}
        steerUnavailableReason={null}
        steerStatus={null}
        onEdit={onEdit}
        onRemove={onRemove}
        onReorder={() => {}}
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
        {...base}
        messages={[message('a', 'one line')]}
        steerUnavailableReason={null}
        steerStatus={null}
        onEdit={onEdit}
        onRemove={noop}
        onReorder={() => {}}
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
        {...base}
        messages={[message('a', 'one line')]}
        steerUnavailableReason={null}
        steerStatus={null}
        onEdit={onEdit}
        onRemove={noop}
        onReorder={() => {}}
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
        {...base}
        messages={[message('a', 'urgent')]}
        steerUnavailableReason="cursor-agent takes one prompt per turn"
        steerStatus={null}
        onEdit={noop}
        onRemove={noop}
        onReorder={() => {}}
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
        {...base}
        messages={[message('a', 'urgent')]}
        steerUnavailableReason={null}
        steerStatus={{ id: 'a', state: 'sending' }}
        onEdit={noop}
        onRemove={noop}
        onReorder={() => {}}
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
        {...base}
        messages={[message('a', 'urgent')]}
        steerUnavailableReason={null}
        steerStatus={{ id: 'a', state: 'held' }}
        onEdit={noop}
        onRemove={noop}
        onReorder={() => {}}
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
        {...base}
        messages={[message('a', 'first'), message('b', 'second')]}
        steerUnavailableReason={null}
        steerStatus={{ id: 'b', state: 'held' }}
        onEdit={noop}
        onRemove={noop}
        onReorder={() => {}}
        onSteer={noop}
      />,
    );
    const rows = el.querySelectorAll('[data-slot="queued-message"]');
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
        {...base}
        messages={[message('a', 'urgent')]}
        steerUnavailableReason={null}
        steerStatus={{ id: 'a', state: 'sending' }}
        onEdit={noop}
        onRemove={noop}
        onReorder={() => {}}
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
        {...base}
        messages={[message('a', 'urgent')]}
        steerUnavailableReason={null}
        steerStatus={{ id: 'a', state: 'held' }}
        onEdit={noop}
        onRemove={noop}
        onReorder={() => {}}
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
        {...base}
        messages={[message('a', 'waiting')]}
        steerUnavailableReason={null}
        steerStatus={null}
        onEdit={noop}
        onRemove={noop}
        onReorder={() => {}}
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
        {...base}
        messages={[message('q1', 'first')]}
        steerUnavailableReason={null}
        steerStatus={null}
        onEdit={onEdit}
        onRemove={noop}
        onReorder={() => {}}
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

describe('QueuedStrip — what "send now" costs, per CLI', () => {
  const message = { id: 'q1', text: 'status?', images: [] };

  it('warns that the press stops the agent, where it does', () => {
    // REPORTED as the send-now control not working on cursor — the channel was
    // declared absent and turned out to exist, but it INTERRUPTS: a second
    // prompt cancels the one in flight. That is worth knowing before the press,
    // since there is nothing to undo after it.
    const container = render(
      <QueuedStrip
        {...base}
        messages={[message]}
        steerUnavailableReason={null}
        steerInterrupts
        steerStatus={null}
        onEdit={() => {}}
        onRemove={() => {}}
        onReorder={() => {}}
        onSteer={() => {}}
      />,
    );

    expect(
      container
        .querySelector('[aria-label="Send queued message 1 now"]')
        ?.getAttribute('title'),
    ).toContain('stops what the agent is doing');
  });

  it('promises nothing of the sort where the message merely JOINS the turn', () => {
    const container = render(
      <QueuedStrip
        {...base}
        messages={[message]}
        steerUnavailableReason={null}
        steerInterrupts={false}
        steerStatus={null}
        onEdit={() => {}}
        onRemove={() => {}}
        onReorder={() => {}}
        onSteer={() => {}}
      />,
    );

    const title = container
      .querySelector('[aria-label="Send queued message 1 now"]')
      ?.getAttribute('title');
    expect(title).toContain('into the turn already running');
    expect(title).not.toContain('stops');
  });

  it('still shows the daemon’s REFUSAL ahead of either sentence', () => {
    // A CLI with no channel at all is a third state, and it outranks both: the
    // control cannot be pressed, so describing what a press would do is wrong.
    const container = render(
      <QueuedStrip
        {...base}
        messages={[message]}
        steerUnavailableReason="this CLI takes one prompt per turn"
        steerInterrupts
        steerStatus={null}
        onEdit={() => {}}
        onRemove={() => {}}
        onReorder={() => {}}
        onSteer={() => {}}
      />,
    );

    expect(
      container
        .querySelector('[aria-label="Send queued message 1 now"]')
        ?.getAttribute('title'),
    ).toBe('this CLI takes one prompt per turn');
  });
});

describe('QueuedStrip — the queue can be PAUSED', () => {
  it('offers Send-now with NO turn running, whatever the CLI says about mid-turn', () => {
    // The refusal above is about the MID-TURN channel. With no turn in flight
    // there is no turn to interrupt — sending simply starts the next one, which
    // every CLI can do. Left blocked here, a paused queue on such an agent has
    // no way out of the pause at all.
    const onSteer = vi.fn();
    const container = render(
      <QueuedStrip
        {...base}
        turnInFlight={false}
        messages={[message('a', 'first')]}
        steerUnavailableReason="this CLI takes one prompt per turn"
        steerStatus={null}
        onEdit={noop}
        onRemove={noop}
        onReorder={noop}
        onSteer={onSteer}
      />,
    );

    const send = container.querySelector(
      '[aria-label="Send queued message 1 now"]',
    )!;
    expect(send.getAttribute('aria-disabled')).toBe('false');
    expect(send.getAttribute('title')).toBe(
      'Send now — it starts the next turn',
    );

    click(send);
    expect(onSteer).toHaveBeenCalledWith('a');
  });

  it('says the queue is PAUSED, and stops promising the head will send itself', () => {
    // `waiting` and `held` are the same row, so the mode has to be said in
    // words — and `sends next` is a promise a paused queue does not make.
    const container = render(
      <QueuedStrip
        {...base}
        paused
        messages={[message('a', 'first'), message('b', 'second')]}
        steerUnavailableReason={null}
        steerStatus={null}
        onEdit={noop}
        onRemove={noop}
        onReorder={noop}
        onSteer={noop}
      />,
    );

    expect(container.textContent).toContain('Queue paused — 2 messages held');
    const rows = container.querySelectorAll('[data-slot="queued-message"]');
    expect(rows[0]!.textContent).not.toContain('sends next');
  });

  it('promotes the HEAD’s Send to a labelled action, and only the head’s', () => {
    // The mode's release. It is the row's own Send control, weighted up rather
    // than a second control elsewhere — so it stays one press, one handler, and
    // the rows below keep the plain glyph, whose job (an out-of-order release)
    // is not what the mode is about.
    const onSteer = vi.fn();
    const messages = [message('a', 'first'), message('b', 'second')];
    const props = {
      ...base,
      messages,
      steerUnavailableReason: null,
      steerStatus: null,
      onEdit: noop,
      onRemove: noop,
      onReorder: noop,
      onSteer,
    };
    render(<QueuedStrip {...props} paused />);

    const head = byLabel('Send queued message 1 now')!;
    expect(head.textContent).toContain('Send');
    // Filled, like the composer's own Send — not a third ghost glyph beside
    // Edit and Remove. This fails the moment it goes back to `variant="ghost"`.
    expect(head.className).toContain('bg-primary');
    expect(byLabel('Send queued message 2 now')!.textContent).toBe('');

    click(head);
    expect(onSteer).toHaveBeenCalledWith('a');

    // Running normally the queue releases itself, so the head is a glyph again.
    rerender(<QueuedStrip {...props} paused={false} />);
    const auto = byLabel('Send queued message 1 now')!;
    expect(auto.textContent).toBe('');
    expect(auto.className).not.toContain('bg-primary');
    expect(container!.textContent).toContain('2 messages queued');
  });

  it('reports the toggle’s state to a screen reader, not just to the eye', () => {
    // The label names what a PRESS does, so `aria-pressed` is the only thing
    // carrying which mode the queue is actually in.
    const onTogglePause = vi.fn();
    const props = {
      ...base,
      messages: [message('a', 'first')],
      steerUnavailableReason: null,
      steerStatus: null,
      onEdit: noop,
      onRemove: noop,
      onReorder: noop,
      onSteer: noop,
      onTogglePause,
    };
    render(<QueuedStrip {...props} />);

    const pause = control('Pause')!;
    expect(pause.getAttribute('aria-pressed')).toBe('false');
    click(pause);
    expect(onTogglePause).toHaveBeenCalledTimes(1);

    rerender(<QueuedStrip {...props} paused />);
    expect(control('Pause')).toBeNull();
    expect(control('Resume')!.getAttribute('aria-pressed')).toBe('true');
  });
});
