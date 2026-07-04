import { describe, expect, it } from 'vitest';

import type { Run } from '../../runs/entity/run.entity';
import { assertChatRun, assertWorkflowRun } from './run-kind';

const chatRun = { id: 'r1', workflowId: null } as unknown as Run;
const workflowRun = { id: 'r2', workflowId: 'wf-1' } as unknown as Run;

describe('assertChatRun', () => {
  it('returns a chat run unchanged', () => {
    expect(assertChatRun(chatRun, 'r1')).toBe(chatRun);
  });

  it('404s a missing run', () => {
    expect(() => assertChatRun(null, 'gone')).toThrowError(
      /RUN_NOT_FOUND|not found/,
    );
  });

  it('rejects a workflow run addressed via a chat endpoint', () => {
    expect(() => assertChatRun(workflowRun, 'r2')).toThrowError(
      /NOT_A_CHAT_RUN|not a single-agent chat/,
    );
  });
});

describe('assertWorkflowRun', () => {
  it('returns a workflow run unchanged', () => {
    expect(assertWorkflowRun(workflowRun, 'r2')).toBe(workflowRun);
  });

  it('404s a missing run', () => {
    expect(() => assertWorkflowRun(null, 'gone')).toThrowError(
      /RUN_NOT_FOUND|not found/,
    );
  });

  it('rejects a chat run addressed via a workflow endpoint', () => {
    expect(() => assertWorkflowRun(chatRun, 'r1')).toThrowError(
      /NOT_A_WORKFLOW_RUN|not a workflow/,
    );
  });
});
