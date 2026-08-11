import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fakeSpawn } from '../__tests__/fake-child';
import { ClaudeAdapter } from '../adapters/claude/claude.adapter';
import { CursorAcpAdapter } from '../adapters/cursor-acp/cursor-acp.adapter';

// The claude→cursor half of the credential-isolation boundary (the sibling
// spawn-cli.env spec pins the cursor→claude half): an Anthropic credential the
// daemon itself inherited must be stripped from every child and re-injected
// ONLY into claude children — a cursor agent or its tool grandchildren never
// see another agent's credential.
describe('inherited Anthropic credential scoping', () => {
  // Every key `CLAUDE_CREDENTIAL_KEYS` covers. The bearer-token pair was
  // missing from that constant, so a daemon launched from a shell exporting one
  // handed a working credential to cursor — the leak this suite exists to deny.
  const KEYS = [
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_CUSTOM_HEADERS',
  ];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });
  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  });

  /** One value per key, so a mix-up between them cannot pass unnoticed. */
  const VALUES: Record<string, string> = {
    ANTHROPIC_API_KEY: 'sk-ant',
    CLAUDE_CODE_OAUTH_TOKEN: 'oauth-tok',
    ANTHROPIC_AUTH_TOKEN: 'bearer-tok',
    ANTHROPIC_CUSTOM_HEADERS: 'Authorization: Bearer header-tok',
  };

  function exportAll(): void {
    for (const key of KEYS) {
      process.env[key] = VALUES[key];
    }
  }

  it("CursorAcpAdapter's child never receives an inherited Anthropic credential", async () => {
    exportAll();
    const { spawn, child, captured } = fakeSpawn();

    const handle = new CursorAcpAdapter({ spawn }).start(
      { prompt: 'go', cwd: '/proj' },
      () => {},
    );
    child.emit('close', 0, null);
    await handle.done;

    // Every key, not a sample: the two bearer-token forms were absent from the
    // strip list precisely because nothing here named them.
    for (const key of KEYS) {
      expect(key in (captured.env ?? {})).toBe(false);
    }
  });

  it('ClaudeAdapter re-injects the inherited Anthropic credentials for its child only', async () => {
    // The other direction, and what makes the strip safe to widen: the same
    // constant drives the re-injection, so a key added to it keeps reaching the
    // CLI that owns it.
    exportAll();
    const { spawn, child, captured } = fakeSpawn();

    const handle = new ClaudeAdapter({ spawn }).start(
      { prompt: 'go', cwd: '/proj' },
      () => {},
    );
    child.emit('close', 0, null);
    await handle.done;

    for (const key of KEYS) {
      expect(captured.env?.[key]).toBe(VALUES[key]);
    }
  });
});
