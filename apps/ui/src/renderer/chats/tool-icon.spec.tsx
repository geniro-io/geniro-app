import { describe, expect, it } from 'vitest';

import { TOOL_OPERATION_META } from './tool-icon';
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
});
