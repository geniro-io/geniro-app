import { describe, expect, it } from 'vitest';

import { AnalysisBroker } from '../../../agents/services/analysis.broker';
import type { ThreadReaderService } from '../../../agents/services/thread-reader.service';
import type {
  WorkflowChange,
  WorkflowChangeService,
} from '../../../graphs/services/workflow-change.service';
import type { McpCallContext } from '../../mcp.types';
import {
  readSaveWorkflowChangeArgs,
  workflowChangeResultText,
} from './save-workflow-change.reader';
import { SaveWorkflowChangeTool } from './save-workflow-change.tool';

const CONTEXT = {
  runId: 'analysis',
  nodeId: 'agent',
  conversationId: null,
  caller: 'agent',
  requestId: 1,
} as McpCallContext;

function tool(slug: string | null) {
  const saved: WorkflowChange[] = [];
  const analysis = new AnalysisBroker();
  analysis.register('analysis', 'agent', {
    turn: {
      analysisRunId: 'analysis',
      sourceRunId: 'source',
      snapshotSeq: 9,
      sourceWorking: false,
    },
    report: () => Promise.reject(new Error('unused')),
    mark: () => Promise.reject(new Error('unused')),
  });
  return {
    saved,
    save: new SaveWorkflowChangeTool(
      analysis,
      {
        workflowOf: () =>
          Promise.resolve(slug === null ? null : { slug, snapshot: null }),
      } as unknown as ThreadReaderService,
      {
        save: (change: WorkflowChange) => {
          saved.push(change);
          return Promise.resolve({ saved: true, backup: '.backups/x.yaml' });
        },
      } as unknown as WorkflowChangeService,
    ),
  };
}

describe('SaveWorkflowChangeTool', () => {
  it("saves the analysed thread's own workflow, on behalf of this analysis", async () => {
    const { save, saved } = tool('dev-team');

    const result = await save.call(
      'save_workflow_change',
      {
        edits: [{ find: 'old', replace: 'new' }],
        baseHash: 'abc',
        ids: ['W-1'],
      },
      CONTEXT,
    );

    expect(result.isError).toBe(false);
    expect(saved).toEqual([
      {
        analysisRunId: 'analysis',
        slug: 'dev-team',
        edits: [{ find: 'old', replace: 'new' }],
        baseHash: 'abc',
        ids: ['W-1'],
        dryRun: false,
      },
    ]);
  });

  it('refuses for a plain chat analysis without touching the library', async () => {
    const { save, saved } = tool(null);

    const result = await save.call(
      'save_workflow_change',
      { edits: [{ path: 'name', value: 'x' }], baseHash: 'abc', ids: ['W-1'] },
      CONTEXT,
    );

    expect(result.content[0]!.text).toContain('NOT_A_WORKFLOW');
    expect(saved).toEqual([]);
  });
});

describe('readSaveWorkflowChangeArgs', () => {
  it('refuses a call naming no recommendation, a malformed id, or a repo id', () => {
    const ids = (value: string[]) =>
      readSaveWorkflowChangeArgs({
        edits: [{ path: 'name', value: 'x' }],
        baseHash: 'a',
        ids: value,
      }).ok;

    expect(ids([])).toBe(false);
    expect(ids(['x'])).toBe(false);
    expect(ids(['R-1'])).toBe(false);
    expect(ids(['W-1'])).toBe(true);
  });
});

describe('readSaveWorkflowChangeArgs edits', () => {
  const edits = (value: unknown) =>
    readSaveWorkflowChangeArgs({ edits: value, baseHash: 'a', ids: ['W-1'] })
      .ok;

  it('reads each edit shape', () => {
    expect(edits([{ find: 'a', replace: 'b' }])).toBe(true);
    expect(edits([{ path: 'nodes/x/model', value: 'sonnet' }])).toBe(true);
    expect(edits([{ path: 'nodes/x/model', remove: true }])).toBe(true);
  });

  it('refuses the whole workflow, no edits, an empty find, and a mixed edit', () => {
    expect(
      readSaveWorkflowChangeArgs({
        workflow: { name: 'Dev Team' },
        baseHash: 'a',
        ids: ['W-1'],
      }).ok,
    ).toBe(false);
    expect(edits([])).toBe(false);
    expect(edits([{ find: '', replace: 'b' }])).toBe(false);
    expect(edits([{ find: 'a', replace: 'b', path: 'name' }])).toBe(false);
  });
});

describe('workflowChangeResultText', () => {
  it('flags a refusal as an error', () => {
    expect(
      workflowChangeResultText({ saved: false, error: 'HASH_DRIFT' }).isError,
    ).toBe(true);
    expect(workflowChangeResultText({ saved: true }).isError).toBe(false);
  });
});
