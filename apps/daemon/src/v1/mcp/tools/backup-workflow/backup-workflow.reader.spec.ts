import { describe, expect, it } from 'vitest';

import { WorkflowBuilderBroker } from '../../../agents/services/workflow-builder.broker';
import type { WorkflowChangeService } from '../../../graphs/services/workflow-change.service';
import type { McpCallContext } from '../../mcp.types';
import { BackupWorkflowTool } from './backup-workflow.tool';

const CONTEXT = {
  runId: 'builder',
  nodeId: 'agent',
  conversationId: null,
  caller: 'agent',
  requestId: 1,
} as McpCallContext;

function tool() {
  const backedUp: string[] = [];
  const builders = new WorkflowBuilderBroker();
  builders.register('builder', 'agent', {
    slug: 'team',
    turnStartedAt: 0,
    savedHash: null,
    acceptsAnyVersion: false,
  });
  return {
    backedUp,
    backup: new BackupWorkflowTool(builders, {
      backUp: (slug: string) => {
        backedUp.push(slug);
        return Promise.resolve({
          backedUp: true,
          backup: `.backups/${slug}.x.yaml`,
        });
      },
    } as unknown as WorkflowChangeService),
  };
}

describe('BackupWorkflowTool', () => {
  it("backs up the builder chat's own workflow, named by the chat", async () => {
    const { backup, backedUp } = tool();

    const result = await backup.call('backup_workflow', {}, CONTEXT);

    expect(result.isError).toBe(false);
    expect(result.content[0]!.text).toContain('.backups/team.x.yaml');
    expect(backedUp).toEqual(['team']);
  });

  it('takes no arguments, a slug included', async () => {
    const { backup, backedUp } = tool();

    const result = await backup.call(
      'backup_workflow',
      { slug: 'other' },
      CONTEXT,
    );

    expect(result.content[0]!.text).toMatch(/^INVALID_ARGS:/);
    expect(backedUp).toEqual([]);
  });

  it('is offered to, and answers, a builder turn only', async () => {
    const { backup, backedUp } = tool();
    const plain = { ...CONTEXT, runId: 'plain' } as McpCallContext;

    expect(backup.list(CONTEXT)).toHaveLength(1);
    expect(backup.list(plain)).toEqual([]);
    expect((await backup.call('backup_workflow', {}, plain)).isError).toBe(
      true,
    );
    expect(backedUp).toEqual([]);
  });
});
