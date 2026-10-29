import { describe, expect, it } from 'vitest';

import {
  RECORDED_NEW_PROPOSAL,
  RECORDED_REPLACE_PROPOSAL,
  REPLACE_TO_AUTO_PROPOSAL,
  STAGES_PROPOSAL,
} from '../__fixtures__/workflow-proposals';
import {
  diffRows,
  previewMarks,
  readProposalOutcome,
  readWorkflowProposal,
  rosterOf,
} from './workflow-proposal-payload';

function parsed(input: unknown) {
  const proposal = readWorkflowProposal(input);
  expect(proposal).not.toBeNull();
  return proposal!;
}

describe('readWorkflowProposal', () => {
  it('reads a recorded new-workflow card', () => {
    const proposal = parsed(RECORDED_NEW_PROPOSAL);
    expect(proposal).toMatchObject({
      mode: 'create',
      slug: 'review-pair',
      autoAgents: ['reviewer'],
      replacesName: null,
      diff: null,
    });
    expect(proposal.workflow.nodes.map((node) => node.id)).toEqual([
      'start',
      'coder',
      'reviewer',
    ]);
  });

  it('reads a recorded replacement with the name it overwrites and its diff', () => {
    const proposal = parsed(RECORDED_REPLACE_PROPOSAL);
    expect(proposal.mode).toBe('replace');
    expect(proposal.replacesName).toBe('Review Pair');
    expect(proposal.diff?.changedNodes).toEqual([
      {
        id: 'reviewer',
        fields: [{ field: 'approval', before: '"auto"', after: '"ask"' }],
      },
    ]);
  });

  it('reads nothing it cannot draw whole, so the card falls back to the permission body', () => {
    const replace = REPLACE_TO_AUTO_PROPOSAL as {
      workflow: { nodes: unknown[] };
      diff: unknown;
    };
    const unreadable: unknown[] = [
      null,
      'propose',
      { ...replace, workflow: undefined },
      { ...replace, mode: 'merge' },
      { ...replace, diff: undefined },
      { ...replace, diff: { identical: false } },
      {
        ...replace,
        diff: {
          ...(replace.diff as object),
          changedStages: [{ id: 'build', fields: [{ field: 'next' }] }],
        },
      },
      { ...replace, autoAgents: 'Coder' },
      {
        ...replace,
        workflow: {
          ...replace.workflow,
          nodes: [
            { id: 'x', kind: 'agent', agent: 'claude', approval: 'yolo' },
          ],
        },
      },
      {
        ...replace,
        workflow: { ...replace.workflow, nodes: [{ id: 'x', kind: 'loop' }] },
      },
      { ...replace, workflow: { ...replace.workflow, stages: 'plan' } },
      {
        ...replace,
        workflow: {
          ...replace.workflow,
          stages: [{ id: 'plan', title: 'Plan' }],
        },
      },
    ];
    for (const input of unreadable) {
      expect(readWorkflowProposal(input)).toBeNull();
    }
  });

  it('drops a blank summary rather than drawing an empty line', () => {
    expect(
      parsed({ ...(RECORDED_NEW_PROPOSAL as object), summary: '   ' }).summary,
    ).toBeNull();
  });

  it('reads the reason trimmed with its line breaks, and none when blank or absent', () => {
    expect(parsed(REPLACE_TO_AUTO_PROPOSAL).reason).toBe(
      'The user asked for tests before review.\nThe coder waited on every edit, so it now runs unattended.',
    );
    expect(
      parsed({ ...(REPLACE_TO_AUTO_PROPOSAL as object), reason: ' \n ' })
        .reason,
    ).toBeNull();
    expect(parsed(RECORDED_NEW_PROPOSAL).reason).toBeNull();
  });
});

describe('readProposalOutcome', () => {
  it('reads a saved slug and a known reason for nothing written', () => {
    expect(readProposalOutcome({ kind: 'saved', slug: 'team' })).toEqual({
      kind: 'saved',
      slug: 'team',
    });
    expect(
      readProposalOutcome({ kind: 'not-saved', cause: 'changed' }),
    ).toEqual({ kind: 'not-saved', cause: 'changed' });
  });

  it('keeps a not-saved reading whose cause this build does not know', () => {
    expect(
      readProposalOutcome({ kind: 'not-saved', cause: 'disk-full' }),
    ).toEqual({ kind: 'not-saved', cause: null });
  });

  it('reads no outcome from a row that carries none', () => {
    expect(readProposalOutcome(null)).toBeNull();
    expect(readProposalOutcome({ kind: 'saved' })).toBeNull();
    expect(readProposalOutcome('saved')).toBeNull();
  });
});

describe('rosterOf', () => {
  it('lists the agents with the names of the instruction blocks wired into each', () => {
    const roster = rosterOf(parsed(REPLACE_TO_AUTO_PROPOSAL).workflow);
    expect(roster.map((row) => [row.node.id, row.instructions])).toEqual([
      ['coder', ['Style']],
      ['tester', []],
      ['reviewer', []],
    ]);
  });

  it('names an unnamed instruction block by its id', () => {
    const { workflow } = parsed(REPLACE_TO_AUTO_PROPOSAL);
    const roster = rosterOf({
      ...workflow,
      nodes: workflow.nodes.map((node) =>
        node.kind === 'instruction' ? { ...node, name: undefined } : node,
      ),
    });
    expect(roster[0]!.instructions).toEqual(['style']);
  });
});

describe('previewMarks', () => {
  it('marks the nodes a replacement adds and changes, and nothing on a new workflow', () => {
    expect([...previewMarks(parsed(REPLACE_TO_AUTO_PROPOSAL).diff)]).toEqual([
      ['coder', 'changed'],
      ['reviewer', 'changed'],
      ['tester', 'added'],
      ['style', 'added'],
    ]);
    expect(previewMarks(parsed(RECORDED_NEW_PROPOSAL).diff).size).toBe(0);
  });
});

describe('diffRows', () => {
  it('puts every change that makes an agent run unasked first', () => {
    const proposal = parsed(REPLACE_TO_AUTO_PROPOSAL);
    const rows = diffRows(proposal.diff!, proposal.workflow);
    expect(rows.filter((row) => row.toAuto).map((row) => row.key)).toEqual([
      'added:tester',
      'changed:coder:approval',
    ]);
    expect(rows.slice(0, 2).every((row) => row.toAuto)).toBe(true);
    expect(
      rows.find((row) => row.key === 'changed:reviewer:approval'),
    ).toMatchObject({
      toAuto: false,
      detail: { before: 'auto', after: 'ask' },
    });
  });

  it('flags a pool change on an agent left running unasked, however long its quoted value', () => {
    const proposal = parsed(REPLACE_TO_AUTO_PROPOSAL);
    const cut = `[{"agent":"codex","model":"${'m'.repeat(390)}… [+80 chars]`;
    const rows = diffRows(
      {
        ...proposal.diff!,
        changedNodes: [
          // The tester's second member runs unasked; its quote is cut off
          // before the approval ever appears.
          {
            id: 'tester',
            fields: [{ field: 'pool', before: '(unset)', after: cut }],
          },
          // The reviewer asks, members and all.
          {
            id: 'reviewer',
            fields: [
              {
                field: 'pool',
                before: '(unset)',
                after: '[{"agent":"codex"}]',
              },
            ],
          },
        ],
      },
      proposal.workflow,
    );
    expect(rows.find((row) => row.key === 'changed:tester:pool')?.toAuto).toBe(
      true,
    );
    expect(
      rows.find((row) => row.key === 'changed:reviewer:pool')?.toAuto,
    ).toBe(false);
  });

  it('flags a pool change only when it leaves the agent running unasked where it did not before', () => {
    const proposal = parsed(REPLACE_TO_AUTO_PROPOSAL);
    const poolRow = (id: string, before: string) =>
      diffRows(
        {
          ...proposal.diff!,
          changedNodes: [
            {
              id,
              fields: [{ field: 'pool', before, after: '[{"agent":"codex"}]' }],
            },
          ],
        },
        proposal.workflow,
      ).find((row) => row.key === `changed:${id}:pool`)?.toAuto;

    // The coder already ran unasked (`approval: auto`, unchanged here): a
    // member's model changing makes nothing newly unasked.
    expect(poolRow('coder', '[{"agent":"codex","model":"a"}]')).toBe(false);
    // The tester's old pool already had its unasked member.
    expect(
      poolRow('tester', '[{"agent":"cursor-agent","approval":"auto"}]'),
    ).toBe(false);
    // Its old pool was asking — the switch is real.
    expect(poolRow('tester', '[{"agent":"cursor-agent"}]')).toBe(true);
    // An old pool cut short cannot be read, so the switch is assumed.
    expect(
      poolRow('tester', '[{"agent":"cursor-agent","mod… [+90 chars]'),
    ).toBe(true);
  });

  it("judges the pool edit alone when the same change moves the agent's own approval", () => {
    const proposal = parsed(REPLACE_TO_AUTO_PROPOSAL);
    const rowsFor = (
      nodeChange: Record<string, unknown>,
      fields: { field: string; before: string; after: string }[],
    ) =>
      diffRows(
        { ...proposal.diff!, changedNodes: [{ id: 'reviewer', fields }] },
        {
          ...proposal.workflow,
          nodes: proposal.workflow.nodes.map((node) =>
            node.id === 'reviewer' ? { ...node, ...nodeChange } : node,
          ),
        } as typeof proposal.workflow,
      );
    const flagged = (rows: ReturnType<typeof diffRows>) =>
      rows
        .filter((row) => row.toAuto && row.subject === 'reviewer')
        .map((row) => row.key);

    // ask → auto, and only a member's model changed: the approval row carries
    // the warning, the pool row does not.
    expect(
      flagged(
        rowsFor({ approval: 'auto', pool: [{ agent: 'codex', model: 'b' }] }, [
          { field: 'approval', before: '"ask"', after: '"auto"' },
          {
            field: 'pool',
            before: '[{"agent":"codex","model":"a"}]',
            after: '[{"agent":"codex","model":"b"}]',
          },
        ]),
      ),
    ).toEqual(['changed:reviewer:approval']);
    // ask → auto with a pool added in the same change: the node is already
    // flagged, and the new member only inherits it.
    expect(
      flagged(
        rowsFor({ approval: 'auto', pool: [{ agent: 'codex' }] }, [
          { field: 'approval', before: '"ask"', after: '"auto"' },
          { field: 'pool', before: '(unset)', after: '[{"agent":"codex"}]' },
        ]),
      ),
    ).toEqual(['changed:reviewer:approval']);
    // auto → ask, while the pool gains a member that is auto on its own: the
    // pool edit is what keeps the agent running unasked.
    expect(
      flagged(
        rowsFor(
          { approval: 'ask', pool: [{ agent: 'codex', approval: 'auto' }] },
          [
            { field: 'approval', before: '"auto"', after: '"ask"' },
            {
              field: 'pool',
              before: '(unset)',
              after: '[{"agent":"codex","approval":"auto"}]',
            },
          ],
        ),
      ),
    ).toEqual(['changed:reviewer:pool']);
  });

  it("unquotes the daemon's values, and reads auto → ask as no switch to auto", () => {
    const proposal = parsed(RECORDED_REPLACE_PROPOSAL);
    expect(diffRows(proposal.diff!, proposal.workflow)).toEqual([
      {
        key: 'changed:reviewer:approval',
        marker: 'changed',
        scope: 'node',
        subject: 'reviewer',
        detail: { field: 'approval', before: 'auto', after: 'ask' },
        toAuto: false,
      },
    ]);
  });

  it('lists each added, changed and removed stage by id', () => {
    const proposal = parsed(STAGES_PROPOSAL);
    expect(diffRows(proposal.diff!, proposal.workflow)).toEqual([
      {
        key: 'added-stage:review',
        marker: 'added',
        scope: 'stage',
        subject: 'review',
        detail: null,
        toAuto: false,
      },
      {
        key: 'changed-stage:build:next',
        marker: 'changed',
        scope: 'stage',
        subject: 'build',
        detail: { field: 'next', before: '["ship"]', after: '["review"]' },
        toAuto: false,
      },
      {
        key: 'removed-stage:ship',
        marker: 'removed',
        scope: 'stage',
        subject: 'ship',
        detail: null,
        toAuto: false,
      },
    ]);
  });
});
