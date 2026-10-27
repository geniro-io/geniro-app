import { describe, expect, it } from 'vitest';

import {
  HOST_BACKUP_WORKFLOW_TOOL,
  HOST_PROPOSE_WORKFLOW_TOOL,
  HOST_READ_WORKFLOWS_TOOL,
  HOST_WORKFLOW_CHANGE_TOOL,
} from '../chat.types';
import {
  isHostBuilderWorkflowCall,
  isHostWorkflowProposalCall,
  workflowVerdictMessage,
} from './host-workflows';

const SERVER = 'geniro-1a2b3c4d';

describe('workflow host-tool predicates', () => {
  it("matches claude's and cursor's spellings of propose_workflow, and only it", () => {
    const read = `${SERVER}-${HOST_READ_WORKFLOWS_TOOL}: ${HOST_READ_WORKFLOWS_TOOL}`;

    expect(
      isHostWorkflowProposalCall(
        SERVER,
        `mcp__${SERVER}__${HOST_PROPOSE_WORKFLOW_TOOL}`,
      ),
    ).toBe(true);
    expect(
      isHostWorkflowProposalCall(
        SERVER,
        `${SERVER}-${HOST_PROPOSE_WORKFLOW_TOOL}: ${HOST_PROPOSE_WORKFLOW_TOOL}`,
      ),
    ).toBe(true);
    expect(isHostWorkflowProposalCall(SERVER, read)).toBe(false);
  });

  it('refuse a same-named tool on somebody else’s server', () => {
    expect(
      isHostWorkflowProposalCall(SERVER, 'mcp__acme__propose_workflow'),
    ).toBe(false);
  });
});

describe('isHostBuilderWorkflowCall', () => {
  const call = (tool: string) => `mcp__${SERVER}__${tool}`;

  it('passes the read, the backup and the check, which write no change', () => {
    for (const tool of [
      HOST_READ_WORKFLOWS_TOOL,
      HOST_BACKUP_WORKFLOW_TOOL,
      HOST_WORKFLOW_CHANGE_TOOL,
    ]) {
      expect(isHostBuilderWorkflowCall(SERVER, call(tool))).toBe(true);
    }
    // The proposal passes on its own predicate, for every chat.
    expect(
      isHostBuilderWorkflowCall(SERVER, call(HOST_PROPOSE_WORKFLOW_TOOL)),
    ).toBe(false);
    expect(
      isHostBuilderWorkflowCall(
        SERVER,
        `mcp__acme__${HOST_WORKFLOW_CHANGE_TOOL}`,
      ),
    ).toBe(false);
  });
});

describe('workflowVerdictMessage', () => {
  it('names the saved slug and the backup of a replaced file', () => {
    expect(
      workflowVerdictMessage({
        kind: 'saved',
        slug: 'team',
        backup: '.backups/team.2026-10-20T10-00-00.yaml',
        note: null,
      }),
    ).toBe(
      "(Approved — saved as 'team' in the workflow library. The previous version is backed up as .backups/team.2026-10-20T10-00-00.yaml.)",
    );
  });

  it('quotes the note typed on Approve, and on a write that did not happen', () => {
    expect(
      workflowVerdictMessage({
        kind: 'saved',
        slug: 'team',
        backup: null,
        note: 'rename the reviewer',
      }),
    ).toBe(
      "(Approved — saved as 'team' in the workflow library. The user's note: rename the reviewer)",
    );
    expect(
      workflowVerdictMessage({
        kind: 'not-saved',
        cause: 'write-failed',
        reason: 'the file could not be written',
        note: 'go',
      }),
    ).toBe(
      "(Not saved — the file could not be written. Read the library again with read_workflows before proposing again. The user's note: go)",
    );
  });

  it('quotes a decline note, and says when there was none', () => {
    expect(
      workflowVerdictMessage({ kind: 'declined', note: '  too many agents ' }),
    ).toBe("(Declined — nothing was saved. The user's note: too many agents)");
    expect(workflowVerdictMessage({ kind: 'declined', note: '   ' })).toBe(
      '(Declined — the user gave no reason. Nothing was saved.)',
    );
  });
});
