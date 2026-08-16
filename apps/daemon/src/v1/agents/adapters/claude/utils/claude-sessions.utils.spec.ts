import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  listClaudeSessions,
  readClaudeSessionHistory,
} from './claude-sessions.utils';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop() as string, { recursive: true, force: true });
  }
});

/** A throwaway profile holding `projects/<dir>/<id>.jsonl` files. */
function profile(
  sessions: { dir: string; id: string; lines: unknown[] }[],
): string {
  const root = mkdtempSync(join(tmpdir(), 'claude-sessions-spec-'));
  roots.push(root);
  for (const session of sessions) {
    const dir = join(root, 'projects', session.dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${session.id}.jsonl`),
      session.lines.map((line) => JSON.stringify(line)).join('\n'),
    );
  }
  return root;
}

/** The shape the CLI appends for a message the user typed. */
function userLine(cwd: string, text: string): unknown {
  return { type: 'user', cwd, message: { role: 'user', content: text } };
}

function assistantLine(cwd: string, text: string): unknown {
  return {
    type: 'assistant',
    cwd,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  };
}

describe('listClaudeSessions', () => {
  it('finds a folder through a DIFFERENT spelling of the same path', async () => {
    // The bug this pins, measured live: the CLI writes `cwd` as its process saw
    // it (`/private/var/…` on macOS) while the app canonicalizes every folder it
    // holds (`/var/…`) — the same directory through a symlink. A string compare
    // rejected every session in the folder the user was sitting in.
    const real = mkdtempSync(join(tmpdir(), 'claude-real-'));
    roots.push(real);
    const link = `${real}-link`;
    symlinkSync(real, link);
    roots.push(link);

    const root = profile([
      { dir: 'proj', id: 's1', lines: [userLine(real, 'the real spelling')] },
    ]);

    // Asked about the LINK, answered from a file that recorded the target.
    const rows = await listClaudeSessions({
      profileDir: root,
      cwd: link,
      limit: 10,
    });
    expect(rows.map((row) => row.id)).toEqual(['s1']);
  });

  it('keeps a folder filter honest — another folder is not offered', async () => {
    const root = profile([
      { dir: 'a', id: 'mine', lines: [userLine('/tmp/mine', 'here')] },
      { dir: 'b', id: 'theirs', lines: [userLine('/tmp/theirs', 'elsewhere')] },
    ]);
    const rows = await listClaudeSessions({
      profileDir: root,
      cwd: '/tmp/mine',
      limit: 10,
    });
    expect(rows.map((row) => row.id)).toEqual(['mine']);
  });

  it('titles a slash-command turn with the command, not its XML envelope', async () => {
    // Observed in the author's own profile: the whole turn is envelopes, so
    // showing it raw filled the row with markup and dropping it left the
    // session unnamed. Both are wrong; the command IS what the user typed.
    const root = profile([
      {
        dir: 'proj',
        id: 'slash',
        lines: [
          userLine(
            '/tmp/proj',
            '<command-message>geniro:implement</command-message>' +
              '<command-name>/geniro:implement</command-name>' +
              '<command-args>next milestone</command-args>',
          ),
        ],
      },
    ]);
    const rows = await listClaudeSessions({
      profileDir: root,
      cwd: null,
      limit: 10,
    });
    expect(rows[0]?.title).toBe('/geniro:implement next milestone');
  });

  it('does not offer a session nobody said anything in', async () => {
    const root = profile([
      {
        dir: 'proj',
        id: 'empty',
        lines: [
          { type: 'queue-operation', cwd: '/tmp/proj', operation: 'enqueue' },
        ],
      },
      { dir: 'proj', id: 'real', lines: [userLine('/tmp/proj', 'hello')] },
    ]);
    const rows = await listClaudeSessions({
      profileDir: root,
      cwd: null,
      limit: 10,
    });
    expect(rows.map((row) => row.id)).toEqual(['real']);
  });

  it('answers an absent profile with an empty list rather than throwing', async () => {
    await expect(
      listClaudeSessions({
        profileDir: join(tmpdir(), 'claude-sessions-spec-nope'),
        cwd: null,
        limit: 10,
      }),
    ).resolves.toEqual([]);
  });
});

describe('readClaudeSessionHistory', () => {
  it('carries BOTH halves of the conversation', async () => {
    // The user's own words have no `AgentEvent` in a live turn — the daemon
    // wrote them — so without the `user_message` arm an imported thread is a
    // column of answers to questions nobody can see.
    const root = profile([
      {
        dir: 'proj',
        id: 's1',
        lines: [
          userLine('/tmp/proj', 'what is 2+2?'),
          assistantLine('/tmp/proj', '4'),
        ],
      },
    ]);
    const history = await readClaudeSessionHistory({
      profileDir: root,
      sessionId: 's1',
      limit: 100,
    });
    expect(history?.events).toEqual([
      { type: 'user_message', text: 'what is 2+2?' },
      { type: 'text', text: '4' },
    ]);
    expect(history?.droppedBefore).toBe(0);
  });

  it("leaves a sub-agent's own conversation out of the main thread", async () => {
    const root = profile([
      {
        dir: 'proj',
        id: 's1',
        lines: [
          userLine('/tmp/proj', 'delegate this'),
          {
            ...(assistantLine('/tmp/proj', 'sidechain chatter') as object),
            isSidechain: true,
          },
          assistantLine('/tmp/proj', 'done'),
        ],
      },
    ]);
    const history = await readClaudeSessionHistory({
      profileDir: root,
      sessionId: 's1',
      limit: 100,
    });
    expect(history?.events).toEqual([
      { type: 'user_message', text: 'delegate this' },
      { type: 'text', text: 'done' },
    ]);
  });

  it('keeps the NEWEST events when the limit bites, and says how many it cut', async () => {
    const root = profile([
      {
        dir: 'proj',
        id: 's1',
        lines: [
          assistantLine('/tmp/proj', 'one'),
          assistantLine('/tmp/proj', 'two'),
          assistantLine('/tmp/proj', 'three'),
        ],
      },
    ]);
    const history = await readClaudeSessionHistory({
      profileDir: root,
      sessionId: 's1',
      limit: 2,
    });
    expect(history?.events).toEqual([
      { type: 'text', text: 'two' },
      { type: 'text', text: 'three' },
    ]);
    expect(history?.droppedBefore).toBe(1);
  });

  it('survives a half-written line instead of losing the transcript', async () => {
    // A session the CLI was appending to when the machine slept ends mid-JSON.
    const root = mkdtempSync(join(tmpdir(), 'claude-sessions-spec-'));
    roots.push(root);
    const dir = join(root, 'projects', 'proj');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 's1.jsonl'),
      `${JSON.stringify(assistantLine('/tmp/proj', 'kept'))}\n{"type":"assis`,
    );
    const history = await readClaudeSessionHistory({
      profileDir: root,
      sessionId: 's1',
      limit: 100,
    });
    expect(history?.events).toEqual([{ type: 'text', text: 'kept' }]);
  });

  it('answers null for a session this profile does not hold', async () => {
    const root = profile([
      { dir: 'proj', id: 's1', lines: [userLine('/tmp/proj', 'hi')] },
    ]);
    await expect(
      readClaudeSessionHistory({
        profileDir: root,
        sessionId: 'not-here',
        limit: 100,
      }),
    ).resolves.toBeNull();
  });
});
