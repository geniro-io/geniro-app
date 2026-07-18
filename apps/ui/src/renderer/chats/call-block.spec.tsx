// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ChatItem } from '../../shared/contracts';
import { CallBlock } from './call-block';
import { type CallBlockEntry, groupTranscript } from './transcript-groups';
import type { TranscriptNodeMeta } from './transcript-item';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const NODES: ReadonlyMap<string, TranscriptNodeMeta> = new Map([
  ['orch', { name: 'Orchestrator', kind: 'agent' }],
  ['poet', { name: 'Poet', kind: 'agent' }],
]);

let seq = 0;
function item(
  kind: ChatItem['kind'],
  payload: unknown,
  nodeId: string,
): ChatItem {
  seq += 1;
  return {
    id: `i-${seq}`,
    runId: 'run-1',
    nodeId,
    seq,
    kind,
    role: null,
    payload,
    createdAt: 'now',
  };
}

function makeBlock(): CallBlockEntry {
  const entries = groupTranscript([
    item(
      'call_started',
      {
        callId: 'call-1',
        calleeNodeId: 'poet',
        mode: 'async',
        message: 'Write a haiku about the sea.',
      },
      'orch',
    ),
    item(
      'status',
      { status: 'running', nodeId: 'poet', callId: 'call-1' },
      'poet',
    ),
    item(
      'message',
      { text: 'Waves rise and retreat', callId: 'call-1' },
      'poet',
    ),
  ]);
  const block = entries[0];
  if (block?.type !== 'call-block') {
    throw new Error('expected a call block');
  }
  return block;
}

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

describe('CallBlock', () => {
  it('collapsed by default: header names caller → callee with live status; the callee text stays hidden', () => {
    act(() => root.render(<CallBlock block={makeBlock()} nodes={NODES} />));

    expect(container.textContent).toContain('Orchestrator → Poet');
    // Wire plumbing stays out of the header — no mode label, no call id.
    expect(container.textContent).not.toContain('async');
    expect(container.textContent).not.toContain('call-1');
    expect(container.textContent).toContain('Write a haiku about the sea.');
    // Live sub-turn: the running spinner is the status (no "Poet started" row).
    expect(container.querySelector('svg.animate-spin')).not.toBeNull();
    expect(container.textContent).not.toContain('Poet started');
    expect(container.textContent).not.toContain('Waves rise and retreat');
  });

  it("a click expands the callee's own messages inside the block", () => {
    act(() => root.render(<CallBlock block={makeBlock()} nodes={NODES} />));

    act(() => {
      container
        .querySelector('button[aria-expanded]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.textContent).toContain('Waves rise and retreat');
  });

  it('a COMPLETED call frames request → result: preview line collapsed, cards expanded', () => {
    const entries = groupTranscript([
      item(
        'call_started',
        {
          callId: 'call-1',
          calleeNodeId: 'poet',
          mode: 'async',
          message: 'Write a haiku about the sea.',
        },
        'orch',
      ),
      item(
        'status',
        { status: 'running', nodeId: 'poet', callId: 'call-1' },
        'poet',
      ),
      item(
        'message',
        { text: 'Waves rise and retreat', callId: 'call-1' },
        'poet',
      ),
      item(
        'status',
        { status: 'completed', nodeId: 'poet', callId: 'call-1' },
        'poet',
      ),
    ]);
    const block = entries[0];
    if (block?.type !== 'call-block') {
      throw new Error('expected a call block');
    }
    act(() => root.render(<CallBlock block={block} nodes={NODES} />));

    // Collapsed: the ↳ result preview shows without expanding.
    expect(container.textContent).toContain('Waves rise and retreat');
    expect(container.querySelector('[data-role="result"]')).toBeNull();

    act(() => {
      container
        .querySelector('button[aria-expanded]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    // Expanded: the ask opens as the REQUEST card, the final answer closes
    // as the RESULT card.
    const request = container.querySelector('[data-role="request"]');
    const result = container.querySelector('[data-role="result"]');
    expect(request?.textContent).toContain('Write a haiku about the sea.');
    expect(result?.textContent).toContain('Waves rise and retreat');
  });
});
