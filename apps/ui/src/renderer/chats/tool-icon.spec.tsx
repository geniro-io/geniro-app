import { describe, expect, it } from 'vitest';

import { TOOL_OPERATION_META, toolRowAccent } from './tool-icon';
import type { ToolOperation } from './tool-kind';

/**
 * The table itself. `ToolCallIcon`'s rendering — operation when done, status
 * otherwise — is driven through the real component in `tool-group.spec.tsx`,
 * which is where the row it belongs to lives.
 */
describe('TOOL_OPERATION_META', () => {
  it('gives every operation its OWN glyph', () => {
    // The entire ask was "a different icon per type of operation", so two
    // operations sharing one is the failure, not a tidiness issue — and it is
    // invisible on screen unless the two happen to appear side by side.
    // (Exhaustiveness itself is the `Record<ToolOperation, …>` type's job; this
    // is about the values being distinct.)
    const icons = Object.values(TOOL_OPERATION_META).map((meta) => meta.icon);
    expect(new Set(icons).size).toBe(icons.length);
  });

  it('reads every tone from a token, never a literal colour', () => {
    // The eslint override catches a hex in a class string; it cannot catch a
    // token that does not exist. Every tone here is one of the three semantic
    // ones the app already defines.
    const tones = new Set(
      Object.values(TOOL_OPERATION_META).map((meta) => meta.tone),
    );
    expect([...tones].sort()).toEqual([
      'text-destructive',
      'text-muted-foreground',
      'text-primary',
    ]);
  });

  it('makes CHANGES stand out and mere looking stay quiet', () => {
    // The two-tier split is the information in the colour: scanning a collapsed
    // turn, what a reader needs to find is the work that altered something.
    // Tint the reads too and the tone stops carrying anything.
    const quiet: ToolOperation[] = [
      'read',
      'search',
      'fetch',
      'delegate',
      'mcp',
    ];
    for (const operation of quiet) {
      expect(TOOL_OPERATION_META[operation].tone).toBe('text-muted-foreground');
    }
    const loud: ToolOperation[] = ['edit', 'create', 'execute', 'move'];
    for (const operation of loud) {
      expect(TOOL_OPERATION_META[operation].tone).toBe('text-primary');
    }
    // Delete is the one operation with a tone of its own: undoing an unwanted
    // edit is reading a diff; undoing an unwanted delete may be impossible.
    expect(TOOL_OPERATION_META.delete.tone).toBe('text-destructive');
  });

  it('marks a delete apart from every other operation', () => {
    const deleted = TOOL_OPERATION_META.delete.accent;
    const others = Object.entries(TOOL_OPERATION_META)
      .filter(([operation]) => operation !== 'delete')
      .map(([, meta]) => meta.accent);
    expect(others).not.toContain(deleted);
  });
});

/**
 * The ROW stripe, a different question from the glyph: the glyph says WHICH
 * operation, the stripe says what that operation COST. `execute` and `edit`
 * share one on purpose — both are the agent changing something, and this
 * transcript's colour rule is that a hue names a consequence rather than a
 * category, so a hue per operation would make the stripe decoration.
 */
describe('toolRowAccent', () => {
  it('gives an MCP call no stripe at all', () => {
    // Classified, but its CONSEQUENCE is unknown: a server tool may well write
    // files, so the "only looked" stripe would be the same unverifiable claim
    // the unclassifiable branch below refuses to make.
    expect(toolRowAccent({ name: 'mcp__fs__write' })).toBeNull();
  });

  it('keeps the two striped classes apart, and each internally equal', () => {
    // BOTH equivalence classes are written down, because a fourth hue can be
    // introduced by splitting either one. Observed: read, search and fetch.
    // Acted: a command and an edit. Splitting either is then a red test and a
    // decision rather than a drift.
    const observed = [
      toolRowAccent({ name: 'Read' }),
      toolRowAccent({ name: 'Grep' }),
      toolRowAccent({ name: 'WebFetch' }),
    ];
    const acted = [
      toolRowAccent({ name: 'Bash' }),
      toolRowAccent({ name: 'Edit' }),
    ];
    expect(new Set(observed).size).toBe(1);
    expect(new Set(acted).size).toBe(1);
    expect(observed[0]).not.toBe(acted[0]);
  });

  it('gives a command and a file edit the SAME stripe, on purpose', () => {
    // The equality is written down rather than left implicit so that separating
    // the two is a red test and a decision, not a silent drift.
    expect(toolRowAccent({ name: 'Bash' })).toBe(
      toolRowAccent({ name: 'Edit' }),
    );
  });

  it('answers null for a call it cannot classify', () => {
    // A stripe here would state a fact about a tool nobody in this app can read.
    expect(toolRowAccent({ name: 'SomeTotallyUnknownTool' })).toBeNull();
    expect(toolRowAccent(null)).toBeNull();
  });
});
