// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BuilderStatusBar } from './builder-status-bar';
import type { AutosaveState } from './use-autosave';

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

function render(
  props: Partial<React.ComponentProps<typeof BuilderStatusBar>> = {},
): void {
  act(() => {
    root.render(
      <BuilderStatusBar
        nodeCount={props.nodeCount ?? 3}
        edgeCount={props.edgeCount ?? 2}
        message={props.message ?? null}
        saveState={props.saveState ?? 'idle'}
      />,
    );
  });
}

function saveLine(): HTMLElement {
  return container.querySelector('[role="status"]')!;
}

describe('BuilderStatusBar', () => {
  it('counts the canvas, pluralising per count', () => {
    render({ nodeCount: 3, edgeCount: 2 });
    expect(container.textContent).toContain('3 nodes · 2 edges');

    render({ nodeCount: 1, edgeCount: 1 });
    expect(container.textContent).toContain('1 node · 1 edge');

    render({ nodeCount: 0, edgeCount: 0 });
    expect(container.textContent).toContain('0 nodes · 0 edges');
  });

  it('reports each save state distinctly', () => {
    const seen = new Map<AutosaveState, string>();
    for (const saveState of [
      'idle',
      'saving',
      'saved',
      'failed',
    ] as AutosaveState[]) {
      render({ saveState });
      seen.set(saveState, saveLine().textContent!.trim());
    }
    expect(seen.get('saving')).toBe('Saving…');
    expect(seen.get('saved')).toBe('Saved');
    expect(seen.get('failed')).toBe('Not saved');
    // No two states may read the same — this line is the ONLY save feedback
    // left in the builder now that the Save button is gone.
    expect(new Set(seen.values()).size).toBe(seen.size);
  });

  it('colours a failed write destructively, a landed one success', () => {
    render({ saveState: 'failed' });
    expect(saveLine().className).toContain('text-destructive');

    render({ saveState: 'saved' });
    expect(saveLine().className).toContain('text-success');
  });

  it('announces the save state politely (no Save button to look at)', () => {
    render({ saveState: 'saving' });
    expect(saveLine().getAttribute('aria-live')).toBe('polite');
  });

  it('shows a transient message and keeps its full text reachable when clipped', () => {
    render({ message: 'Exported to /Users/me/Desktop/main.geniro.yaml' });
    const line = container.querySelector('[title]')!;
    expect(line.textContent).toContain(
      'Exported to /Users/me/Desktop/main.geniro.yaml',
    );
    expect(line.getAttribute('title')).toBe(
      'Exported to /Users/me/Desktop/main.geniro.yaml',
    );
  });

  it('renders without a message', () => {
    render({ message: null });
    expect(container.querySelector('[title]')).toBeNull();
    expect(container.textContent).toContain('3 nodes');
  });
});
