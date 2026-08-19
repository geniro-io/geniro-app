// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BlockRequest, BlockResult, BlockShell } from './block-shell';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function toggle(): HTMLButtonElement | null {
  return container.querySelector('button[aria-expanded]');
}

describe('BlockShell', () => {
  it('renders no disclosure control when it is not collapsible, and shows the body', () => {
    act(() =>
      root.render(
        <BlockShell
          eyebrow="Agent communication"
          eyebrowIcon={<span />}
          header={<span>Orchestrator → Poet</span>}
          status="running">
          <p>inner thread</p>
        </BlockShell>,
      ),
    );

    expect(container.textContent).toContain('Agent communication');
    expect(container.textContent).toContain('Orchestrator → Poet');
    expect(container.textContent).toContain('inner thread');
    expect(toggle()).toBeNull();
  });

  it('starts CLOSED when collapsible, and opens on click', () => {
    // One prop decides both facts: collapsible blocks are asides the reader
    // opens deliberately, so there is no collapsible-and-already-open state to
    // ask for.
    act(() =>
      root.render(
        <BlockShell
          eyebrow="Sub-agent"
          eyebrowIcon={<span />}
          header={<span>code-reviewer</span>}
          status="done"
          collapsible
          toggleLabel="Show the sub-agent's conversation">
          <p>inner thread</p>
        </BlockShell>,
      ),
    );

    const button = toggle();
    expect(button?.getAttribute('aria-expanded')).toBe('false');
    // Closed: the identity line and status still read, the thread does not.
    expect(container.textContent).toContain('code-reviewer');
    expect(container.textContent).toContain('done');
    expect(container.textContent).not.toContain('inner thread');
    // And `done` reads as the CHECK, not as a pill: a settled block is the
    // common case, so a green chip on every one of them was the loudest thing
    // in a run of asides. The word survives for a screen reader only, which is
    // why the assertion above cannot tell the two apart and this one can.
    expect(container.querySelector('[data-status="completed"]')).not.toBeNull();
    expect(
      container.querySelector('[data-slot="block-status-badge"]'),
    ).toBeNull();

    act(() =>
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );

    expect(toggle()?.getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain('inner thread');
  });

  it('puts a header action BESIDE the disclosure, never inside it', () => {
    // Interactive content nested in a <button> is invalid HTML whatever role
    // it carries, and a control there also swallows presses meant for the
    // toggle. Both halves are asserted: the action is outside the button, and
    // pressing it does not open the block.
    const pressed: string[] = [];
    act(() =>
      root.render(
        <BlockShell
          eyebrow="Sub-agent"
          eyebrowIcon={<span />}
          header={<span>code-reviewer</span>}
          status="done"
          collapsible
          toggleLabel="Show the sub-agent's conversation"
          headerAction={
            <button
              type="button"
              aria-label="Open in a panel"
              onClick={() => pressed.push('action')}
            />
          }>
          <p>inner thread</p>
        </BlockShell>,
      ),
    );

    const action = container.querySelector('[aria-label="Open in a panel"]');
    expect(action).not.toBeNull();
    expect(toggle()?.contains(action)).toBe(false);

    act(() =>
      action?.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    expect(pressed).toEqual(['action']);
    expect(toggle()?.getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).not.toContain('inner thread');
  });

  it('spins only while running', () => {
    const shell = (status: 'running' | 'done'): React.JSX.Element => (
      <BlockShell
        eyebrow="Sub-agent"
        eyebrowIcon={<span />}
        header={<span>code-reviewer</span>}
        status={status}
        collapsible
        toggleLabel="Show the sub-agent's conversation">
        <p>inner thread</p>
      </BlockShell>
    );

    act(() => root.render(shell('running')));
    expect(container.querySelector('svg.animate-spin')).not.toBeNull();
    expect(container.textContent).toContain('running');
    // One mark, not two: a spinner BESIDE a `running` pill said it twice.
    expect(
      container.querySelector('[data-slot="block-status-badge"]'),
    ).toBeNull();

    act(() => root.render(shell('done')));
    expect(container.querySelector('svg.animate-spin')).toBeNull();
  });

  it('keeps the WORD for the two statuses a glyph cannot carry', () => {
    // The pill did not go away, it narrowed to where it earns its ink: a
    // failed or abandoned block is what a reader scans a long transcript for,
    // and a red or grey glyph among a column of green checks is not enough to
    // stop on.
    for (const status of ['error', 'stopped'] as const) {
      act(() =>
        root.render(
          <BlockShell
            eyebrow="Sub-agent"
            eyebrowIcon={<span />}
            header={<span>code-reviewer</span>}
            status={status}
            collapsible
            toggleLabel="Show the sub-agent's conversation">
            <p>inner thread</p>
          </BlockShell>,
        ),
      );
      const pill = container.querySelector('[data-slot="block-status-badge"]');
      expect(pill?.textContent).toBe(status);
    }
  });

  it('states the KIND of aside on the header, never as a line above the card', () => {
    // The eyebrow line is what made a delegate read as its own message in the
    // flow: an icon and a word sitting outside the card, so two stacked
    // delegates were four things on screen. It is a glyph on the header now,
    // with the word left for a screen reader — so the label is still in the
    // page and must be found INSIDE the card, never before it.
    act(() =>
      root.render(
        <BlockShell
          eyebrow="Sub-agent"
          eyebrowIcon={<span data-testid="kind-glyph" />}
          header={<span>code-reviewer</span>}
          status="done"
          collapsible
          toggleLabel="Show the sub-agent's conversation">
          <p>inner thread</p>
        </BlockShell>,
      ),
    );

    const shell = container.querySelector('[data-role="block-shell"]');
    const card = shell?.querySelector('div.overflow-hidden');
    expect(card?.textContent).toContain('Sub-agent');
    expect(card?.querySelector('[data-testid="kind-glyph"]')).not.toBeNull();
    // Nothing at all between the shell and its card.
    expect(shell?.children.length).toBe(1);
    expect(shell?.firstElementChild).toBe(card);
  });
});

describe('BlockRequest / BlockResult tints', () => {
  /** The tinted panel each of them wraps its text in. */
  function panelClasses(node: React.JSX.Element): string {
    act(() => root.render(node));
    const panel = container.querySelector('div > div[class*="rounded-lg"]');
    return panel?.className ?? '';
  }

  it('gives the request panel a tint of its own, not the card’s own beige', () => {
    // `primary/5` was 5% of a brown already close to the cream background: the
    // panel came out the same colour as the card holding it, so "what this was
    // asked to do" read as one more paragraph of the surrounding block. It is
    // the FIRST thing in every enclosure and the one panel that has to be
    // separable at a glance.
    const request = panelClasses(<BlockRequest label="Task" text="do it" />);
    expect(request).not.toContain('bg-primary/5');
    expect(request).toContain('bg-secondary/20');
  });

  it('keeps the two panels DISTINGUISHABLE, which is what the pair means', () => {
    // The real promise, and the one a future retint must not break: a reader
    // tells the ask from the answer by colour. Asserting they merely differ
    // would pass with both set to the same near-invisible wash, so each is also
    // pinned to its own token family.
    const request = panelClasses(<BlockRequest label="Task" text="do it" />);
    const result = panelClasses(<BlockResult label="Result" text="done" />);

    expect(request).not.toBe(result);
    expect(request).toContain('secondary');
    expect(result).toContain('success');
  });
});

describe('the clamped panel', () => {
  /** A prompt long enough that the panel clamps it. */
  const LONG = Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n');

  /** The clamped box itself — the one carrying the max-height. */
  function clamp(): HTMLElement | null {
    return container.querySelector('div[style*="max-height"]');
  }

  it('truncates WITHOUT becoming a scroll container', () => {
    // The reported bug, and the reason this is asserted on the class rather
    // than on behaviour: `overflow: hidden` truncates AND makes the box
    // scrollable — invisibly, with no scrollbar and no gesture that scrolls it
    // back. Anything bringing a descendant into view then shifts the content up
    // for good, so the clamp cuts through the middle of its FIRST line. It is
    // reproducible: `Dialog` focuses the first focusable child on open, and for
    // a request panel leading with a fenced block that child is the fence's
    // Copy button INSIDE this box. jsdom implements neither scrolling nor
    // overflow, so the browser half was probe-confirmed instead (`scrollTop =
    // 40` sticks under `hidden`, is refused under `clip`) and what is pinned
    // here is the one thing this component decides: which of the two it asks
    // for.
    act(() => root.render(<BlockRequest label="Task" text={LONG} />));
    const box = clamp();
    expect(box).not.toBeNull();
    expect(box?.className).toContain('overflow-clip');
    expect(box?.className).not.toContain('overflow-hidden');
  });

  it('drops the clamp entirely once expanded, rather than clipping a taller box', () => {
    act(() => root.render(<BlockRequest label="Task" text={LONG} />));
    const more = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Show more'),
    );
    act(() => more?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(clamp()).toBeNull();
  });
});

describe('BlockShell header hover surface', () => {
  /** The header row and the disclosure inside it. */
  function header(): { row: Element; button: Element | null } {
    const row = container.querySelector(
      '[data-role="block-shell"] > div.overflow-hidden > div',
    );
    if (row === null) {
      throw new Error('expected a header row');
    }
    return { row, button: row.querySelector('button[aria-expanded]') };
  }

  it('puts the hover fill on the ROW, never on the disclosure inside it', () => {
    // Measured on a live block before this: the button's own hover filled
    // x=0..858 of an 888px row, leaving the 30px the header action occupies at
    // the row's untouched tone — two colours in one row, which is why the expand
    // control read as a separate cell notched into the card's corner. Moving the
    // fill up to the row is what makes it one surface, so the assertion is about
    // WHERE the class lives.
    act(() =>
      root.render(
        <BlockShell
          eyebrow="Sub-agent"
          eyebrowIcon={<span />}
          header={<span>code-reviewer</span>}
          status="done"
          collapsible
          toggleLabel="Show the sub-agent's conversation"
          headerAction={<button type="button">open</button>}>
          <p>inner thread</p>
        </BlockShell>,
      ),
    );
    const { row, button } = header();

    // The FAMILY, not the alpha: which token carries the hover is the promise
    // (see below), while `/70` vs `/60` is a designer's dial and pinning it
    // would fail a tone tweak that keeps every claim here true.
    expect(row.className).toMatch(/hover:bg-muted/);
    expect(button?.className ?? '').not.toMatch(/hover:bg-/);
    // Neutral, not the apricot it was: `accent` is now the request panel's
    // colour, so a hovered header and the ask below it read as one tone.
    expect(row.className).not.toMatch(/hover:bg-accent/);
  });

  it('offers no hover affordance on a header that is not a disclosure', () => {
    // A call block's header does not open anything — highlighting it on hover
    // promises a press that does nothing.
    act(() =>
      root.render(
        <BlockShell
          eyebrow="Agent communication"
          eyebrowIcon={<span />}
          header={<span>poet</span>}
          status="running">
          <p>the sub-turn</p>
        </BlockShell>,
      ),
    );
    const { row, button } = header();

    expect(button).toBeNull();
    expect(row.className).not.toMatch(/hover:bg-/);
  });
});
