// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { MilestonePayload } from './milestone-payload';
import { MilestoneRow } from './milestone-row';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const STEP: MilestonePayload = {
  text: 'Wrote the timeline route.',
  kind: 'progress',
  nodeId: 'engineer',
  conversationId: null,
};

describe('MilestoneRow', () => {
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

  function render(props: Partial<Parameters<typeof MilestoneRow>[0]> = {}) {
    act(() => {
      root.render(
        <MilestoneRow milestone={STEP} author="Engineer" {...props} />,
      );
    });
  }

  it('draws the member, the step text and its clock time on one row', () => {
    render({ time: '14:02' });
    const row = container.querySelector('[data-slot="milestone"]');
    expect(row?.getAttribute('data-kind')).toBe('progress');
    expect(row?.textContent).toContain('Engineer');
    expect(row?.textContent).toContain('Wrote the timeline route.');
    expect(row?.querySelector('time')?.textContent).toBe('14:02');
  });

  it.each([
    ['progress', 'Step'],
    ['problem', 'Problem found'],
    ['done', 'Done'],
  ] as const)(
    'names a %s step by its words, not only its colour',
    (kind, label) => {
      render({ milestone: { ...STEP, kind } });
      expect(
        container.querySelector('[data-slot="milestone"]')?.textContent,
      ).toContain(label);
    },
  );

  it('says Agent when the row has no member name', () => {
    render({ author: null });
    expect(container.textContent).toContain('Agent');
  });

  it('leaves the time out when none is given', () => {
    render();
    expect(container.querySelector('time')).toBeNull();
  });
});
