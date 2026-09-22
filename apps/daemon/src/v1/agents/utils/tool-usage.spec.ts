import { describe, expect, it } from 'vitest';

import { foldToolUsage, toolLabel, type ToolUsageGroup } from './tool-usage';

function group(over: Partial<ToolUsageGroup> = {}): ToolUsageGroup {
  return {
    nodeId: 'engineer',
    name: 'Bash',
    toolKind: 'execute',
    calls: 1,
    ...over,
  };
}

describe('toolLabel', () => {
  it("keeps a tool's own name, MCP's long ones included", () => {
    // The whole point of the histogram on the claude side: `Bash` and
    // `mcp__…__await_agent` are different tools and must stay different rows.
    // The MCP name is the longest genuine one measured on a real profile (70
    // characters), so a shorter ceiling would collapse every MCP tool into its
    // kind — the table's most informative rows.
    expect(toolLabel('Bash', 'execute')).toBe('Bash');
    expect(toolLabel('Read File', 'read')).toBe('Read File');
    expect(
      toolLabel(
        'mcp__claude_ai_Manifest_OS_Google_Workspace__bigquery_list_dataset_ids',
        null,
      ),
    ).toBe(
      'mcp__claude_ai_Manifest_OS_Google_Workspace__bigquery_list_dataset_ids',
    );
  });

  it('answers with the KIND when the CLI titled the call after its arguments', () => {
    // Verbatim from a real row: on the ACP transport `payload.name` is the
    // CLI's own title, and for a shell call that is the command. Read as a tool
    // name it is both a claim nobody made and — at up to 37,630 characters —
    // past the wire's label cap, which failed the whole response.
    expect(
      toolLabel(
        '`gh pr view 5251 --repo manifestlaw-labs/ManifestOS --json number,title`',
        'execute',
      ),
    ).toBe('execute');
    expect(
      toolLabel('Task: Verify findings: delete dialog, pristine save', 'other'),
    ).toBe('other');
  });

  it('says `tool` rather than inventing one when the row names neither', () => {
    expect(toolLabel('`true`', null)).toBe('tool');
    expect(toolLabel('   ', '')).toBe('tool');
  });
});

describe('foldToolUsage', () => {
  it('sums the collapsed titles instead of keeping the largest', () => {
    // The re-aggregation IS the fix: three shell calls reach the fold as three
    // groups of one, and a table saying `execute 1` would under-report the
    // busiest thing the agent did by the whole of it.
    const { toolUse } = foldToolUsage(
      [
        group({ nodeId: 'qa', name: '`pnpm build`', calls: 1 }),
        group({ nodeId: 'qa', name: '`git status`', calls: 1 }),
        group({ nodeId: 'qa', name: '`kill 4821`', calls: 1 }),
        group({ nodeId: 'qa', name: 'Read File', toolKind: 'read', calls: 40 }),
      ],
      10,
    );

    expect(toolUse).toEqual([
      { nodeId: 'qa', name: 'Read File', calls: 40 },
      { nodeId: 'qa', name: 'execute', calls: 3 },
    ]);
  });

  it('keeps one lane out of another lane, under the same tool name', () => {
    // The table filters by lane, so two agents running `Bash` are two rows —
    // folded on the name alone, one agent's work would be billed to the other.
    const { toolUse } = foldToolUsage(
      [
        group({ nodeId: 'engineer', calls: 86 }),
        group({ nodeId: 'qa', calls: 4 }),
      ],
      10,
    );

    expect(toolUse).toEqual([
      { nodeId: 'engineer', name: 'Bash', calls: 86 },
      { nodeId: 'qa', name: 'Bash', calls: 4 },
    ]);
  });

  it('says it is capped rather than passing a short table off as the whole', () => {
    const groups = Array.from({ length: 4 }, (_unused, index) =>
      group({ name: `Tool${index}`, calls: index + 1 }),
    );

    expect(foldToolUsage(groups, 2)).toEqual({
      toolUse: [
        { nodeId: 'engineer', name: 'Tool3', calls: 4 },
        { nodeId: 'engineer', name: 'Tool2', calls: 3 },
      ],
      capped: true,
    });
    expect(foldToolUsage(groups, 4).capped).toBe(false);
  });
});
