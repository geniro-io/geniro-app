// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ChatItem } from '../../shared/contracts';
import { CallBlock } from './call-block';
import { TranscriptEntryView } from './transcript-entry';
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
  it('renders the geniro communication card: eyebrow, avatar pair, name line, status chip — always open', () => {
    act(() =>
      root.render(<TranscriptEntryView entry={makeBlock()} nodes={NODES} />),
    );

    // Always-open card (no collapse toggle), identity in the header.
    expect(container.textContent).toContain('Agent communication');
    expect(container.textContent).toContain('Orchestrator → Poet');
    expect(container.querySelector('button[aria-expanded]')).toBeNull();
    // Wire plumbing stays out — no mode label, no call id.
    expect(container.textContent).not.toContain('async');
    expect(container.textContent).not.toContain('call-1');
    // The ask renders as the clamped instructions section.
    expect(container.textContent).toContain('Providing instructions for Poet');
    expect(container.textContent).toContain('Write a haiku about the sea.');
    // Live sub-turn: spinner + running chip + thinking line, no status rows.
    expect(container.querySelector('svg.animate-spin')).not.toBeNull();
    expect(container.textContent).toContain('running');
    expect(container.textContent).toContain('Poet is thinking...');
    expect(container.textContent).not.toContain('Poet started');
    // The callee's streamed messages render INSIDE the card, live.
    expect(container.textContent).toContain('Waves rise and retreat');
  });

  it('a COMPLETED call ends with the "Result from X" section', () => {
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

    // The final message renders under the "Result from X" label (pulled out
    // of the flow), the status chip flips to done.
    expect(container.textContent).toContain('Result from Poet');
    expect(container.textContent).toContain('Waves rise and retreat');
    expect(container.textContent).toContain('done');
    expect(container.textContent).not.toContain('is thinking');
  });
});
