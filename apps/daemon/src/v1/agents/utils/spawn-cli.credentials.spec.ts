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
  const KEYS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];
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

  it("CursorAcpAdapter's child never receives an inherited Anthropic credential", async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-tok';
    const { spawn, child, captured } = fakeSpawn();

    const handle = new CursorAcpAdapter({ spawn }).start(
      { prompt: 'go', cwd: '/proj' },
      () => {},
    );
    child.emit('close', 0, null);
    await handle.done;

    expect('ANTHROPIC_API_KEY' in (captured.env ?? {})).toBe(false);
    expect('CLAUDE_CODE_OAUTH_TOKEN' in (captured.env ?? {})).toBe(false);
  });

  it('ClaudeAdapter re-injects the inherited Anthropic credentials for its child only', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-tok';
    const { spawn, child, captured } = fakeSpawn();

    const handle = new ClaudeAdapter({ spawn }).start(
      { prompt: 'go', cwd: '/proj' },
      () => {},
    );
    child.emit('close', 0, null);
    await handle.done;

    expect(captured.env?.ANTHROPIC_API_KEY).toBe('sk-ant');
    expect(captured.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-tok');
  });
});
