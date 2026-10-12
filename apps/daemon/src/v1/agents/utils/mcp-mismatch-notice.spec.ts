import { describe, expect, it } from 'vitest';

import { mcpMismatchNotice } from './mcp-mismatch-notice';

describe('mcpMismatchNotice', () => {
  it('says nothing when the turn started with every server it was shown with', () => {
    expect(mcpMismatchNotice({ missing: [], cleared: [] })).toBeNull();
  });

  it('says the record was cleared and the next message gets the server', () => {
    expect(
      mcpMismatchNotice({
        missing: ['claude.ai Figma'],
        cleared: ['claude.ai Figma'],
      }),
    ).toBe(
      "claude.ai Figma showed as connected but was not loaded in this turn — the agent's CLI still had it marked as needing sign-in. Geniro cleared that, so the next turn starts a fresh session with it.",
    );
  });

  it('promises a fresh session and points at a re-check when nothing could be cleared', () => {
    // The session is retired either way; a "sign in again" would point at a
    // row that reads Connected and offers no such button.
    expect(mcpMismatchNotice({ missing: ['a', 'b'], cleared: [] })).toBe(
      "a, b showed as connected but were not loaded in this turn — the agent's CLI reported them as needing sign-in. The next turn starts a fresh session that connects again; if they are still missing then, re-check them in the MCP panel.",
    );
  });
});
