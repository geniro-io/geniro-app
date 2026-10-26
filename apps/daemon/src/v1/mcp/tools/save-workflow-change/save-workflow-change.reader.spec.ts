import { describe, expect, it } from 'vitest';

import { AnalysisBroker } from '../../../agents/services/analysis.broker';
import type { ThreadReaderService } from '../../../agents/services/thread-reader.service';
import { WorkflowBuilderBroker } from '../../../agents/services/workflow-builder.broker';
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

const BUILDER_CONTEXT = { ...CONTEXT, runId: 'builder' } as McpCallContext;

/**
 * The tool over doubles. `answers` are what successive saves answer, in turn;
 * past the last one every save answers `{saved: true}`.
 */
function tool(slug: string | null, answers: Record<string, unknown>[] = []) {
  const saved: WorkflowChange[] = [];
  const analysis = new AnalysisBroker();
  const builders = new WorkflowBuilderBroker();
  builders.register('builder', 'agent', {
    slug: 'team',
    turnStartedAt: 5,
    savedHash: null,
    acceptsAnyVersion: false,
  });
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
      builders,
      {
        workflowOf: () =>
          Promise.resolve(slug === null ? null : { slug, snapshot: null }),
      } as unknown as ThreadReaderService,
      {
        save: (change: WorkflowChange) => {
          saved.push(change);
          return Promise.resolve(
            answers.shift() ?? { saved: true, backup: '.backups/x.yaml' },
          );
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
        authority: {
          kind: 'apply',
          analysisRunId: 'analysis',
          ids: ['W-1'],
          baseHash: 'abc',
        },
        slug: 'dev-team',
        edits: [{ find: 'old', replace: 'new' }],
        dryRun: false,
      },
    ]);
  });

  it("saves a builder chat's own workflow, named by the chat and never by the model", async () => {
    const { save, saved } = tool('dev-team');

    const result = await save.call(
      'save_workflow_change',
      { edits: [{ path: 'name', value: 'x' }], dryRun: true },
      BUILDER_CONTEXT,
    );

    expect(result.isError).toBe(false);
    expect(saved).toEqual([
      {
        authority: {
          kind: 'builder',
          savedHash: null,
          turnStartedAt: 5,
          acceptsAnyVersion: false,
        },
        slug: 'team',
        edits: [{ path: 'name', value: 'x' }],
        dryRun: true,
      },
    ]);
  });

  it('checks each later save of the turn against the version the last one wrote or found', async () => {
    const { save, saved } = tool('dev-team', [
      { saved: true, hash: 'written' },
      { saved: false, error: 'HASH_DRIFT', currentHash: 'found' },
    ]);
    const call = () =>
      save.call(
        'save_workflow_change',
        { edits: [{ path: 'name', value: 'x' }] },
        BUILDER_CONTEXT,
      );

    await call();
    await call();
    await call();

    expect(saved.map((change) => change.authority)).toEqual([
      {
        kind: 'builder',
        savedHash: null,
        turnStartedAt: 5,
        acceptsAnyVersion: false,
      },
      {
        kind: 'builder',
        savedHash: 'written',
        turnStartedAt: 5,
        acceptsAnyVersion: false,
      },
      {
        kind: 'builder',
        savedHash: 'found',
        turnStartedAt: 5,
        acceptsAnyVersion: false,
      },
    ]);
  });

  it('never notes a version into the turn after the one a late save belongs to', async () => {
    const builders = new WorkflowBuilderBroker();
    builders.register('builder', 'agent', {
      slug: 'team',
      turnStartedAt: 5,
      savedHash: null,
      acceptsAnyVersion: false,
    });
    const save = new SaveWorkflowChangeTool(
      new AnalysisBroker(),
      builders,
      {} as ThreadReaderService,
      {
        // The user stops the turn and sends again while this save is out.
        save: () => {
          builders.register('builder', 'agent', {
            slug: 'team',
            turnStartedAt: 9,
            savedHash: null,
            acceptsAnyVersion: false,
          });
          return Promise.resolve({ saved: true, hash: 'late' });
        },
      } as unknown as WorkflowChangeService,
    );

    await save.call(
      'save_workflow_change',
      { edits: [{ path: 'name', value: 'x' }] },
      BUILDER_CONTEXT,
    );

    await expect(builders.workflowOf('builder', 'agent')).resolves.toEqual({
      slug: 'team',
      turnStartedAt: 9,
      savedHash: null,
      acceptsAnyVersion: false,
    });
  });

  it('lets the next save take the repaired file after a refusal for a file it could not load', async () => {
    const { save, saved } = tool('dev-team', [
      { saved: false, error: 'WORKFLOW_UNREADABLE', message: 'x' },
      { saved: true, hash: 'repaired' },
    ]);
    const call = () =>
      save.call(
        'save_workflow_change',
        { edits: [{ path: 'name', value: 'x' }] },
        BUILDER_CONTEXT,
      );

    await call();
    await call();
    await call();

    expect(
      saved.map(({ authority }) =>
        authority.kind === 'builder'
          ? [authority.savedHash, authority.acceptsAnyVersion]
          : null,
      ),
    ).toEqual([
      [null, false],
      [null, true],
      ['repaired', false],
    ]);
  });

  it('refuses recommendation ids and a hash from a builder chat', async () => {
    const { save, saved } = tool('dev-team');
    const refused = async (extra: Record<string, unknown>) =>
      (
        await save.call(
          'save_workflow_change',
          { edits: [{ path: 'name', value: 'x' }], ...extra },
          BUILDER_CONTEXT,
        )
      ).content[0]!.text;

    expect(await refused({ ids: ['W-1'] })).toMatch(/^INVALID_ARGS:/);
    expect(await refused({ baseHash: 'abc' })).toMatch(/^INVALID_ARGS:/);
    expect(saved).toEqual([]);
  });

  it('refuses a call from a turn that may change no workflow', async () => {
    const { save, saved } = tool('dev-team');

    const result = await save.call(
      'save_workflow_change',
      { edits: [{ path: 'name', value: 'x' }] },
      { ...CONTEXT, runId: 'plain' } as McpCallContext,
    );

    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: 'Nothing saved: no turn is running that may change a workflow.',
        },
      ],
      isError: true,
    });
    expect(saved).toEqual([]);
  });

  it('lists the builder wording and asks no ids of a builder chat only', () => {
    const { save } = tool('dev-team');

    const [builder] = save.list(BUILDER_CONTEXT);
    const [analysis] = save.list(CONTEXT);

    expect(builder!.description).toMatch(/the workflow this chat edits/);
    expect(builder!.inputSchema).not.toHaveProperty('properties.ids');
    expect(builder!.inputSchema).not.toHaveProperty('properties.baseHash');
    expect(analysis!.description).toMatch(/the analysed thread's workflow/);
    expect(analysis!.inputSchema).toHaveProperty(
      'required',
      expect.arrayContaining(['ids']),
    );
    expect(save.list({ ...CONTEXT, runId: 'plain' })).toEqual([]);
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
