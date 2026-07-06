// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ChatItem, ChatItemKind } from '../../shared/contracts';
import { TranscriptItem } from './transcript-item';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function item(kind: ChatItemKind, payload: unknown, nodeId = 'orch'): ChatItem {
  return {
    id: `${kind}-1`,
    runId: 'run-1',
    nodeId,
    seq: 1,
    kind,
    role: null,
    payload,
    createdAt: new Date(0).toISOString(),
  };
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

function render(el: React.ReactNode): void {
  act(() => root.render(el));
}

describe('TranscriptItem — agent-call rows', () => {
  it('renders call_started with the callee, mode, id, and message', () => {
    render(
      <TranscriptItem
        item={item('call_started', {
          callId: 'call-1',
          calleeNodeId: 'helper',
          mode: 'async',
          message: 'summarize the diff',
        })}
      />,
    );
    const text = container.textContent ?? '';
    expect(text).toContain('call → helper');
    expect(text).toContain('async');
    expect(text).toContain('call-1');
    expect(text).toContain('summarize the diff');
  });

  it("a sync call_started omits the redundant 'sync' mode tag", () => {
    render(
      <TranscriptItem
        item={item('call_started', {
          callId: 'call-1',
          calleeNodeId: 'helper',
          mode: 'sync',
          message: 'go',
        })}
      />,
    );
    expect(container.textContent).not.toContain('sync');
  });

  it('renders an ok call_result with the returned text', () => {
    render(
      <TranscriptItem
        item={item('call_result', {
          callId: 'call-1',
          calleeNodeId: 'helper',
          status: 'ok',
          result: { call_id: 'call-1', agent: 'helper', text: 'the answer' },
        })}
      />,
    );
    const el = container.querySelector('[data-role="call"]');
    expect(el).not.toBeNull();
    expect(el?.textContent).toContain('result ← helper');
    expect(el?.textContent).toContain('the answer');
  });

  it('renders an error call_result via the error bubble with the envelope error', () => {
    render(
      <TranscriptItem
        item={item('call_result', {
          callId: 'call-1',
          calleeNodeId: 'helper',
          status: 'error',
          error: 'CALLEE_FAILED: exit 1',
        })}
      />,
    );
    const el = container.querySelector('[data-role="error"]');
    expect(el).not.toBeNull();
    expect(el?.textContent).toContain('call failed ← helper');
    expect(el?.textContent).toContain('CALLEE_FAILED: exit 1');
  });

  it('renders await_collected as a note referencing the call id', () => {
    render(
      <TranscriptItem item={item('await_collected', { callId: 'call-2' })} />,
    );
    expect(container.textContent).toContain('collected call-2');
  });
});
