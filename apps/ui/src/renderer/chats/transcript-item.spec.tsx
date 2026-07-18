// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ChatItem, ChatItemKind } from '../../shared/contracts';
import { TranscriptItem, type TranscriptNodeMeta } from './transcript-item';

const NODES: ReadonlyMap<string, TranscriptNodeMeta> = new Map([
  ['start', { name: 'Start', kind: 'trigger' }],
  ['orch', { name: 'Orchestrator', kind: 'agent' }],
  ['epilogue', { name: 'Epilogue', kind: 'agent' }],
]);

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function item(
  kind: ChatItemKind,
  payload: unknown,
  nodeId: string | null = 'orch',
): ChatItem {
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
  it('renders call_started with the callee and message — no wire plumbing (mode, call id)', () => {
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
    expect(text).toContain('summarize the diff');
    expect(text).not.toContain('async');
    expect(text).not.toContain('call-1');
  });

  it('renders an ok call_result as a COMPACT receipt — the result text lives in the call block', () => {
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
    expect(container.textContent).toContain('✓ result from helper');
    expect(container.textContent).not.toContain('the answer');
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

  it('renders await_collected as NOTHING — broker pickup bookkeeping is not a message', () => {
    render(
      <TranscriptItem item={item('await_collected', { callId: 'call-2' })} />,
    );
    expect(container.textContent).toBe('');
  });
});

describe('TranscriptItem — Q&A bridge rows (M4)', () => {
  it('renders call_question with the callee, question text, and options', () => {
    render(
      <TranscriptItem
        item={item('call_question', {
          callId: 'call-1',
          calleeNodeId: 'helper',
          question: 'Which color?',
          options: ['Red', 'Blue'],
        })}
      />,
    );
    const text = container.textContent ?? '';
    expect(text).toContain('question ← helper');
    expect(text).not.toContain('call-1');
    expect(text).toContain('Which color?');
    expect(text).toContain('Red / Blue');
  });

  it('renders an answered call_answer with the answer text', () => {
    render(
      <TranscriptItem
        item={item('call_answer', {
          callId: 'call-1',
          calleeNodeId: 'helper',
          answer: 'Blue',
          outcome: 'answered',
        })}
      />,
    );
    const text = container.textContent ?? '';
    expect(text).toContain('answered → helper');
    expect(text).toContain('Blue');
  });

  it('renders timeout, orphaned, and undelivered call_answer outcomes as errors', () => {
    render(
      <TranscriptItem
        item={item('call_answer', {
          callId: 'call-1',
          calleeNodeId: 'helper',
          outcome: 'timeout',
        })}
      />,
    );
    expect(container.textContent).toContain('timed out');

    render(
      <TranscriptItem
        item={item('call_answer', {
          callId: 'call-2',
          calleeNodeId: 'helper',
          outcome: 'orphaned',
        })}
      />,
    );
    expect(container.textContent).toContain('orphaned');

    render(
      <TranscriptItem
        item={item('call_answer', {
          callId: 'call-3',
          calleeNodeId: 'helper',
          outcome: 'undelivered',
        })}
      />,
    );
    expect(container.textContent).toContain('undelivered');
  });

  it('status rows speak in node display names, not "id → status" arrows', () => {
    render(
      <TranscriptItem
        item={item('status', { status: 'running' })}
        nodes={NODES}
      />,
    );
    expect(container.textContent).toContain('Orchestrator started');

    render(
      <TranscriptItem
        item={item('status', { status: 'completed' })}
        nodes={NODES}
      />,
    );
    expect(container.textContent).toContain('✓ Orchestrator finished');
    expect(container.textContent).not.toContain('→');

    render(
      <TranscriptItem
        item={item(
          'status',
          { status: 'skipped', reason: 'an upstream node did not complete' },
          'epilogue',
        )}
        nodes={NODES}
      />,
    );
    expect(container.textContent).toContain(
      '− Epilogue skipped — an upstream node did not complete',
    );
  });

  it('a trigger node\'s status row is hidden entirely ("start → completed" noise)', () => {
    render(
      <TranscriptItem
        item={item('status', { status: 'completed' }, 'start')}
        nodes={NODES}
      />,
    );
    expect(container.textContent).toBe('');
  });

  it('a NODE-level turn_complete renders nothing — the status row narrates the finish', () => {
    render(
      <TranscriptItem
        item={item('turn_complete', {
          usage: { costUsd: 0.07 },
          stopReason: 'end_turn',
        })}
        nodes={NODES}
      />,
    );
    expect(container.textContent).toBe('');
  });

  it('a system advisory renders as a red expandable row with full details on click', () => {
    render(
      <TranscriptItem
        item={item('system', {
          message: 'agent calls disabled\nspawn cursor-agent ENOENT',
        })}
        nodes={NODES}
      />,
    );
    const row = container.querySelector('[data-role="error"]');
    expect(row).not.toBeNull();
    expect(row?.className).toContain('destructive');
    expect(container.textContent).toContain('agent calls disabled');
    expect(container.textContent).not.toContain('spawn cursor-agent ENOENT');

    act(() => {
      container
        .querySelector('button[aria-expanded]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.textContent).toContain('spawn cursor-agent ENOENT');
  });

  it('an error renders red and expands to its full message on click', () => {
    render(
      <TranscriptItem
        item={item('error', {
          message: 'claude exited with code 143\nstderr tail here',
        })}
      />,
    );
    expect(container.querySelector('[data-role="error"]')?.className).toContain(
      'destructive',
    );
    expect(container.textContent).not.toContain('stderr tail here');
    act(() => {
      container
        .querySelector('button[aria-expanded]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.textContent).toContain('stderr tail here');
  });

  it('a workflow run-level turn_complete renders by its stopReason roll-up, never a blanket ✓ done', () => {
    // The daemon ends EVERY workflow run with a turn_complete whose
    // stopReason carries the roll-up — a failed run must not read "✓ done".
    render(
      <TranscriptItem
        item={item(
          'turn_complete',
          { usage: null, stopReason: 'workflow_failed' },
          null,
        )}
      />,
    );
    expect(container.textContent).toContain('✗ failed');
    expect(container.textContent).not.toContain('✓ done');

    render(
      <TranscriptItem
        item={item(
          'turn_complete',
          { usage: null, stopReason: 'workflow_cancelled' },
          null,
        )}
      />,
    );
    expect(container.textContent).toContain('⊘ cancelled');
    expect(container.textContent).not.toContain('✓ done');

    render(
      <TranscriptItem
        item={item(
          'turn_complete',
          { usage: null, stopReason: 'workflow_completed' },
          null,
        )}
      />,
    );
    expect(container.textContent).toContain('✓ done');
  });

  it('an approval_verdict with an answer shows the answered line', () => {
    render(
      <TranscriptItem
        item={item('approval_verdict', {
          id: 'q-1',
          allow: true,
          answer: 'Blue',
        })}
      />,
    );
    expect(container.textContent).toContain('✓ answered — Blue');
  });
});
