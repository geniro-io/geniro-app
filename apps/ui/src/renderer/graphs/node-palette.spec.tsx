// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NODE_DND_MIME, NodePalette, parsePaletteItem } from './node-palette';
import { NODE_CONNECTION_RULES, NODE_TYPE_SCHEMAS } from './node-schema';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.clear(); // persisted width/fold state must not leak between tests
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function render(): void {
  act(() => {
    root.render(<NodePalette />);
  });
}

/** The draggable tiles (the fold/category buttons are not draggable). */
function tiles(): HTMLButtonElement[] {
  return Array.from(
    container.querySelectorAll<HTMLButtonElement>('button'),
  ).filter((b) => b.draggable);
}

function tileByLabel(label: string): HTMLButtonElement | undefined {
  return tiles().find((b) => b.textContent?.includes(label));
}

function byLabel(label: string): HTMLButtonElement | undefined {
  return Array.from(
    container.querySelectorAll<HTMLButtonElement>('button'),
  ).find((b) => b.getAttribute('aria-label') === label);
}

function click(el: Element | undefined): void {
  act(() => {
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function dialog(): Element | null {
  return container.querySelector('[role="dialog"]');
}

describe('NodePalette', () => {
  it('renders one draggable tile per trigger and agent', () => {
    render();
    expect(tiles()).toHaveLength(3); // Manual + Claude + Cursor
    expect(container.textContent).toContain('Triggers');
    expect(container.textContent).toContain('Agents');
    expect(container.textContent).toContain('Manual');
    expect(container.textContent).toContain('Claude');
    expect(container.textContent).toContain('Cursor');
  });

  it('opens the info dialog on click — never adds a node', () => {
    // Clicking a tile must open its read-only details, not drop a node
    // (matches geniro: drag to add, click for info).
    render();
    click(tileByLabel('Claude'));

    expect(dialog()).not.toBeNull();
    expect(dialog()?.textContent).toContain('Claude');
    expect(dialog()?.textContent).toContain('claude'); // the CLI command
    expect(dialog()?.textContent).toContain('Drag this agent onto the canvas');
  });

  it('the info dialog offers a click/keyboard add path — "Add to canvas" fires onAdd and closes', () => {
    // Drag is not the only way in: keyboard users (and failed trackpad drags)
    // add through the dialog's button, which hands the item to the canvas's
    // position-less add (stack-to-the-right placement).
    const onAdd = vi.fn();
    act(() => {
      root.render(<NodePalette onAdd={onAdd} />);
    });
    click(tileByLabel('Claude'));

    const add = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((b) => b.textContent === 'Add to canvas');
    expect(add).toBeDefined();
    click(add);

    expect(onAdd).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'agent', agent: 'claude' }),
    );
    expect(dialog()).toBeNull();
  });

  it('without onAdd the info dialog stays drag-only (no Add button)', () => {
    render();
    click(tileByLabel('Claude'));

    expect(
      Array.from(container.querySelectorAll('button')).some(
        (b) => b.textContent === 'Add to canvas',
      ),
    ).toBe(false);
  });

  it("renders each kind's own schema in the info dialog", () => {
    render();
    const schemaKeys = (): string[] =>
      Array.from(
        container.querySelectorAll('[aria-label="Node schema"] code'),
      ).map((el) => el.textContent ?? '');

    click(tileByLabel('Claude'));
    expect(schemaKeys()).toEqual(NODE_TYPE_SCHEMAS.agent.map((f) => f.key));
    click(byLabel('Close'));

    click(tileByLabel('Manual'));
    expect(schemaKeys()).toEqual(NODE_TYPE_SCHEMAS.trigger.map((f) => f.key));
  });

  it('renders one connection-rule row per registry rule, with arity and partners', () => {
    // The Connections section is driven by NODE_CONNECTION_RULES — one row
    // per input/output rule showing the accepted kind, its arity badge, and
    // the concrete node types matching the rule.
    render();
    click(tileByLabel('Claude'));

    const rules = container.querySelector('[aria-label="Connection rules"]');
    expect(rules).not.toBeNull();
    expect(rules?.textContent).toContain('Inputs');
    expect(rules?.textContent).toContain('Outputs');

    const rows = rules?.querySelectorAll('code') ?? [];
    const expected = [
      ...NODE_CONNECTION_RULES.agent.inputs,
      ...NODE_CONNECTION_RULES.agent.outputs,
    ];
    expect(Array.from(rows).map((el) => el.textContent)).toEqual(
      expected.map((rule) => rule.kind),
    );
    expect(rules?.textContent).toContain('multiple'); // agent→agent is multi-edge
    expect(rules?.textContent).toContain('single'); // trigger→agent is single
    // kind `agent` partners are the concrete CLI agents.
    expect(rules?.textContent).toContain('Claude');
    expect(rules?.textContent).toContain('Cursor');
  });

  it("shows the trigger's empty input side as an explicit entry-point note", () => {
    render();
    click(tileByLabel('Manual'));

    const rules = container.querySelector('[aria-label="Connection rules"]');
    expect(rules?.textContent).toContain('None — nothing can feed a trigger');
    // Its single output rule fans out to agents.
    expect(rules?.textContent).toContain('multiple');
  });

  it('closes the info dialog on ✕', () => {
    render();
    click(tiles()[0]);
    expect(dialog()).not.toBeNull();

    click(byLabel('Close'));
    expect(dialog()).toBeNull();
  });

  it('writes the palette item as JSON under the shared DND mime on drag start', () => {
    // The canvas drop handler reads NODE_DND_MIME back through
    // parsePaletteItem — pin the exact payload round-trip for both kinds.
    render();
    const setData = vi.fn();
    const drag = (tile: HTMLButtonElement | undefined): void => {
      const event = new Event('dragstart', {
        bubbles: true,
      }) as unknown as DragEvent;
      Object.defineProperty(event, 'dataTransfer', {
        value: { setData, effectAllowed: '' },
      });
      act(() => {
        tile?.dispatchEvent(event);
      });
    };

    drag(tileByLabel('Claude'));
    drag(tileByLabel('Manual'));

    const payloads = setData.mock.calls.map(([mime, payload]) => {
      expect(mime).toBe(NODE_DND_MIME);
      return parsePaletteItem(payload as string);
    });
    expect(payloads).toEqual([
      { kind: 'agent', agent: 'claude' },
      { kind: 'trigger', trigger: 'manual' },
    ]);
  });

  it('parsePaletteItem rejects garbage payloads', () => {
    expect(parsePaletteItem('')).toBeNull();
    expect(parsePaletteItem('not json')).toBeNull();
    expect(parsePaletteItem('{"kind":"agent","agent":"nope"}')).toBeNull();
    expect(parsePaletteItem('{"kind":"trigger","trigger":"cron"}')).toBeNull();
  });

  it('folds the whole panel to a rail and expands again', () => {
    render();
    expect(tiles()).toHaveLength(3);

    click(byLabel('Collapse palette'));
    expect(tiles()).toHaveLength(0); // folded — tiles gone

    click(byLabel('Expand palette'));
    expect(tiles()).toHaveLength(3);
  });

  it('collapses one category block without touching the other', () => {
    render();
    const headers = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).filter((b) => b.getAttribute('aria-expanded') === 'true');
    expect(headers).toHaveLength(2); // Triggers + Agents

    const agentsHeader = headers.find((b) => b.textContent?.includes('Agents'));
    click(agentsHeader);
    expect(agentsHeader?.getAttribute('aria-expanded')).toBe('false');
    expect(tiles()).toHaveLength(1); // Manual stays; Claude/Cursor hidden
  });

  it('resizes on drag and persists the new width', () => {
    render();
    const width = (): number =>
      parseInt(container.querySelector('aside')!.style.width || '0', 10);
    const start = width(); // DEFAULT_WIDTH = 240
    const handle = container.querySelector('[role="separator"]')!;

    act(() => {
      handle.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, clientX: 240 }),
      );
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 320 }));
      window.dispatchEvent(new MouseEvent('mouseup'));
    });

    expect(width()).toBe(start + 80); // 240 + (320 − 240)
    expect(localStorage.getItem('geniro.builder.paletteWidth')).toBe('320');
  });
});
