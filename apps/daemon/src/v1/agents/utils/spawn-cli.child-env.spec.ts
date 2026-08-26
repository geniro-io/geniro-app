import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fakeSpawn } from '../__tests__/fake-child';
import { freshVocabularyStore } from '../adapters/__tests__/fresh-vocabulary-store';
import { ClaudeAdapter } from '../adapters/claude/claude.adapter';
import { CursorAcpAdapter } from '../adapters/cursor-acp/cursor-acp.adapter';
import { runHeadlessCli } from './spawn-cli';

// The credential-isolation boundary is a CLAUDE.md hard rule: a spawned agent
// must never inherit the daemon's GENIRO_-prefixed config/secrets, and the
// Cursor key must reach ONLY the cursor child. These assert that contract so a
// silent regression (dropping the GENIRO_ strip, or a key leaking across agents)
// fails a test rather than leaking a credential in production.
describe('spawned-agent env scoping', () => {
  const KEYS = [
    'GENIRO_SECRET',
    'GENIRO_CURSOR_API_KEY',
    'NORMAL_VAR',
    'CURSOR_API_KEY',
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

  it('strips every GENIRO_-prefixed key, passes other vars through, merges extra', async () => {
    process.env.GENIRO_SECRET = 'leak-me';
    process.env.NORMAL_VAR = 'keep-me';
    const { spawn, child, captured } = fakeSpawn();

    const handle = runHeadlessCli({
      command: 'claude',
      args: [],
      cwd: '/proj',
      env: { EXTRA: 'injected' },
      mapper: () => [],
      onEvent: () => {},
      spawn,
    });
    child.emit('close', 0, null);
    await handle.done;

    expect(captured.env?.NORMAL_VAR).toBe('keep-me');
    expect(captured.env?.EXTRA).toBe('injected');
    expect('GENIRO_SECRET' in (captured.env ?? {})).toBe(false);
  });

  it("CursorAcpAdapter re-injects the user's own inherited CURSOR_API_KEY", async () => {
    // geniro no longer mints a key, so the only one that can appear is the
    // user's own, exported in the shell that launched the app. `buildChildEnv`
    // strips it from every child; the adapter's buildEnv puts it back for this
    // one.
    process.env.CURSOR_API_KEY = 'sk-user-own';
    const { spawn, child, captured } = fakeSpawn();

    const handle = new CursorAcpAdapter({
      vocabularyStore: freshVocabularyStore(),
      spawn,
    }).start({ prompt: 'go', cwd: '/proj' }, () => {});
    child.emit('close', 0, null);
    await handle.done;

    expect(captured.env?.CURSOR_API_KEY).toBe('sk-user-own');
  });

  it("ClaudeAdapter's child never receives the Cursor credential", async () => {
    // Set the INHERITED name, which is the only live source now. Setting the
    // retired GENIRO_ var here would make this pass with the strip deleted —
    // nothing reads that name any more, so it could not leak in the first
    // place. This is the assertion that keeps "no spawned agent inherits
    // another agent's credential" true once the key is un-minted.
    process.env.CURSOR_API_KEY = 'sk-user-own';
    const { spawn, child, captured } = fakeSpawn();

    const handle = new ClaudeAdapter({ spawn }).start(
      { prompt: 'go', cwd: '/proj' },
      () => {},
    );
    child.emit('close', 0, null);
    await handle.done;

    expect(captured.env?.CURSOR_API_KEY).toBeUndefined();
  });
});
