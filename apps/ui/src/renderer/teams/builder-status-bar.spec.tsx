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
        memberCount={props.memberCount ?? 3}
        stageCount={props.stageCount ?? 2}
        message={props.message ?? null}
        saveState={props.saveState ?? 'idle'}
        pausedReason={props.pausedReason ?? null}
      />,
    );
  });
}

function saveLine(): HTMLElement {
  return container.querySelector('[role="status"]')!;
}

describe('BuilderStatusBar', () => {
  it('counts the team, pluralising per count', () => {
    render({ memberCount: 3, stageCount: 2 });
    expect(container.textContent).toContain('3 members · 2 stages');

    render({ memberCount: 1, stageCount: 1 });
    expect(container.textContent).toContain('1 member · 1 stage');

    render({ memberCount: 0, stageCount: 0 });
    expect(container.textContent).toContain('0 members · 0 stages');
  });

  it('says why held edits are not written, only while paused', () => {
    render({ saveState: 'paused', pausedReason: 'fix the problems first' });
    expect(saveLine().textContent!.trim()).toBe(
      'Not saved yet — fix the problems first',
    );

    render({ saveState: 'saved', pausedReason: 'fix the problems first' });
    expect(saveLine().textContent!.trim()).toBe('Saved');
  });

  it('reports each save state distinctly', () => {
    const seen = new Map<AutosaveState, string>();
    for (const saveState of [
      'idle',
      'saving',
      'saved',
      'failed',
      'paused',
    ] as AutosaveState[]) {
      render({ saveState });
      seen.set(saveState, saveLine().textContent!.trim());
    }
    expect(seen.get('saving')).toBe('Saving…');
    expect(seen.get('saved')).toBe('Saved');
    expect(seen.get('failed')).toBe('Not saved');
    // Held-back edits must never read as "Up to date" — that is what a leave
    // then silently discarded.
    expect(seen.get('paused')).toBe('Not saved yet');
    // No two states may read the same — this line is the ONLY save feedback
    // left in the builder now that the Save button is gone.
    expect(new Set(seen.values()).size).toBe(seen.size);
  });

  it('colours a failed write destructively, a landed one success', () => {
    render({ saveState: 'failed' });
    expect(saveLine().className).toContain('text-destructive');

    render({ saveState: 'saved' });
    expect(saveLine().className).toContain('text-success');

    render({ saveState: 'paused' });
    expect(saveLine().className).toContain('text-warning');
  });

  it('announces the save state politely (no Save button to look at)', () => {
    render({ saveState: 'saving' });
    expect(saveLine().getAttribute('aria-live')).toBe('polite');
  });

  it('shows a transient message and keeps its full text reachable when clipped', () => {
    render({ message: 'Exported to /Users/me/Desktop/main.team.yaml' });
    const line = container.querySelector('[title]')!;
    expect(line.textContent).toContain(
      'Exported to /Users/me/Desktop/main.team.yaml',
    );
    expect(line.getAttribute('title')).toBe(
      'Exported to /Users/me/Desktop/main.team.yaml',
    );
  });

  it('renders without a message', () => {
    render({ message: null });
    expect(container.querySelector('[title]')).toBeNull();
    expect(container.textContent).toContain('3 members');
  });
});
