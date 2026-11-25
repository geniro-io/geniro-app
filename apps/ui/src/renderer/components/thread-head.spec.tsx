// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ThreadHead, type ThreadIdentity } from './thread-head';

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

const IDENTITY: ThreadIdentity = {
  title: 'Billing fixes',
  face: {
    kind: 'member',
    name: 'Senior Engineer',
    avatar: null,
    colorKey: 'senior',
  },
  pullRequest: null,
  status: { attention: 'done', text: 'finished' },
  agentLabel: 'claude',
  isTeam: false,
  boardCard: null,
  project: 'PriceField',
  projectColor: 'orange',
};

function headOf(compact?: boolean): HTMLElement {
  act(() =>
    root.render(
      <ThreadHead identity={IDENTITY} slot="thread-head" compact={compact} />,
    ),
  );
  const head = container.querySelector<HTMLElement>(
    '[data-slot="thread-head-head"]',
  );
  if (head === null) {
    throw new Error('the head rendered nothing');
  }
  return head;
}

function partOf(head: HTMLElement, slot: string): HTMLElement {
  const part = head.querySelector<HTMLElement>(`[data-slot="${slot}"]`);
  if (part === null) {
    throw new Error(`no ${slot}`);
  }
  return part;
}

describe('ThreadHead', () => {
  it('draws its labels on a line of their own under the title by default', () => {
    const head = headOf();

    const title = partOf(head, 'thread-head-title');
    const labels = partOf(head, 'thread-head-labels');
    expect(labels.parentElement).not.toBe(title.parentElement);
    expect(partOf(head, 'thread-head-face').dataset.size).toBe('md');
    expect(head.hasAttribute('data-compact')).toBe(false);
  });

  it('draws its labels on the title line when compact, with a small face', () => {
    const head = headOf(true);

    const title = partOf(head, 'thread-head-title');
    const labels = partOf(head, 'thread-head-labels');
    expect(labels.parentElement).toBe(title.parentElement);
    expect(partOf(head, 'thread-head-face').dataset.size).toBe('sm');
    expect(head.hasAttribute('data-compact')).toBe(true);
  });
});
