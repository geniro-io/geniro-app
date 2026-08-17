import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
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

/**
 * A fixed epoch-seconds mark the ordered fixtures are stamped around.
 *
 * The listing sorts newest-first, so any test whose claim depends on the ORDER
 * files are decided in has to state that order rather than inherit it from how
 * fast the machine wrote them.
 */
const TS_BASE = 1_700_000_000;

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

  it('keeps newest-first order across the head-read batches', async () => {
    // Heads are read eight at a time now, so the ordering and the limit both
    // have to survive a boundary rather than falling out of a single sequential
    // walk. Twenty files with distinct mtimes puts two full boundaries inside
    // the answer.
    const root = mkdtempSync(join(tmpdir(), 'claude-sessions-spec-'));
    roots.push(root);
    const dir = join(root, 'projects', 'proj');
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 20; i += 1) {
      const file = join(dir, `s${i}.jsonl`);
      writeFileSync(file, JSON.stringify(userLine('/tmp/proj', `msg ${i}`)));
      // Newest LAST by index, so a reader that ignored mtime would answer in
      // the opposite order to the one asserted.
      utimesSync(file, new Date(1_000 + i), new Date(1_000 + i));
    }

    const rows = await listClaudeSessions({
      profileDir: root,
      cwd: null,
      limit: 12,
    });

    expect(rows.map((row) => row.id)).toEqual([
      's19',
      's18',
      's17',
      's16',
      's15',
      's14',
      's13',
      's12',
      's11',
      's10',
      's9',
      's8',
    ]);
  });

  it('rejects a whole folder from one file, and the rejection outlives a batch boundary', async () => {
    // One file identifies its directory and the rest are skipped, which is what
    // keeps a filtered listing over thousands of sessions to a few hundred
    // small reads. The rejection has to survive the boundary: nine files is one
    // more than a batch holds.
    //
    // The LAST file in the rejected folder carries the wanted cwd, and that is
    // what makes this a pin rather than a description. Without it the expected
    // answer is `['m1']` whether or not any rejection happens at all — every
    // other file in `theirs` names a folder that would be filtered out anyway
    // on its own merits, so the assertion held with the short-circuit deleted
    // wholesale. `t8` can ONLY be excluded by the directory-level rejection,
    // which is the behaviour the title claims.
    //
    // Excluding it is correct, not a loss: the directory name is the cwd with
    // its separators flattened, so one directory genuinely can hold two
    // folders' sessions — and the sibling test below pins that whichever answer
    // this gives, it gives the same one however the boundary falls.
    const root = mkdtempSync(join(tmpdir(), 'claude-sessions-spec-'));
    roots.push(root);
    const theirs = join(root, 'projects', 'theirs');
    mkdirSync(theirs, { recursive: true });
    for (let i = 0; i < 9; i += 1) {
      const path = join(theirs, `t${i}.jsonl`);
      writeFileSync(
        path,
        JSON.stringify(
          userLine(i === 8 ? '/tmp/mine' : '/tmp/theirs', 'elsewhere'),
        ),
      );
      // Stamped rather than left to the clock. The listing decides newest-first,
      // so what this test pins — a folder rejected by an EARLIER file, with the
      // wanted `t8` behind the rejection — only holds if `t8` sorts last. Nine
      // writes normally land inside one millisecond and the stable sort then
      // preserves this loop's order, but on a loaded machine they straddle a
      // tick, `t8` becomes the newest of the nine and is decided BEFORE anything
      // has rejected the directory: measured as an intermittent
      // `['m1','t8']` under the full suite, passing alone every time.
      utimesSync(path, TS_BASE - i, TS_BASE - i);
    }
    const mine = join(root, 'projects', 'mine');
    mkdirSync(mine, { recursive: true });
    const minePath = join(mine, 'm1.jsonl');
    writeFileSync(minePath, JSON.stringify(userLine('/tmp/mine', 'here')));
    // Newest of all, so the one row that must survive is decided first and the
    // assertion cannot pass by the rejection merely reaching it in time.
    utimesSync(minePath, TS_BASE + 1, TS_BASE + 1);

    const rows = await listClaudeSessions({
      profileDir: root,
      cwd: '/tmp/mine',
      limit: 10,
    });

    expect(rows.map((row) => row.id)).toEqual(['m1']);
  });

  it('answers one folder the same way however many neighbours precede it', async () => {
    // A project directory CAN hold two folders' sessions. The directory name is
    // the cwd with its separators flattened to `-`, which this module's own doc
    // block records as lossy — `/a/b-c` and `/a-b/c` collide onto one name — so
    // the "one directory, one folder" premise the rejection short-circuit rests
    // on is not something the store guarantees.
    //
    // Where the short-circuit is consulted is now what decides the answer. It
    // is read once per BATCH, before any of the eight heads is decided over, so
    // a directory rejected by its first file still spares only the files that
    // fall into a LATER batch. The same store therefore answers the same
    // question two different ways depending on how many unrelated sessions
    // happen to sort ahead of the one being asked about — a listing whose
    // contents turn on other files' mtimes.
    const listing = async (neighbours: number): Promise<string[]> => {
      const root = mkdtempSync(join(tmpdir(), 'claude-sessions-spec-'));
      roots.push(root);
      const shared = join(root, 'projects', 'a-b-c');
      const own = join(root, 'projects', 'mine');
      mkdirSync(shared, { recursive: true });
      mkdirSync(own, { recursive: true });
      // Newest first, one second apart, so the global sort order is stated by
      // the fixture rather than left to the filesystem.
      let at = 1_700_000_000_000;
      const write = (path: string, cwd: string, text: string): void => {
        writeFileSync(path, JSON.stringify(userLine(cwd, text)));
        utimesSync(path, new Date(at), new Date(at));
        at -= 1_000;
      };
      for (let i = 0; i < neighbours; i += 1) {
        write(join(shared, `o${i}.jsonl`), '/tmp/other', 'the other folder');
      }
      // Same collided directory, the user's OWN folder.
      write(join(shared, 'collided.jsonl'), '/tmp/mine', 'mine, in there too');
      // A second directory the collision does not touch, so neither answer can
      // be empty and the assertion below has something to be wrong about.
      write(join(own, 'm1.jsonl'), '/tmp/mine', 'mine, on its own');
      const rows = await listClaudeSessions({
        profileDir: root,
        cwd: '/tmp/mine',
        limit: 10,
      });
      return rows.map((row) => row.id);
    };

    // One neighbour puts `collided` in the first batch; eight push it past the
    // boundary. Nothing else about the two profiles differs.
    const sparse = await listing(1);
    const crowded = await listing(8);

    expect(sparse).toContain('m1');
    expect(crowded).toEqual(sparse);
  });

  it('does not offer a session whose first words are past the head budget', async () => {
    // Both this and the guard below are LIVE on a real profile — 7 of 563
    // sessions have their first user line past the 256KB budget — and neither
    // was reachable from the spec's five listing cases. The budget exists
    // because a session's opening routinely carries tens of kilobytes of hook
    // output and system-reminder blocks before anyone speaks.
    const root = mkdtempSync(join(tmpdir(), 'claude-sessions-spec-'));
    roots.push(root);
    const dir = join(root, 'projects', 'proj');
    mkdirSync(dir, { recursive: true });
    const filler = JSON.stringify({
      type: 'system',
      cwd: '/tmp/proj',
      text: 'x'.repeat(4_000),
    });
    const lines: string[] = [];
    // Past CLAUDE_SESSION_HEAD_BUDGET_BYTES (256KB) before the user speaks.
    for (let i = 0; i < 80; i += 1) {
      lines.push(filler);
    }
    lines.push(JSON.stringify(userLine('/tmp/proj', 'said far too late')));
    writeFileSync(join(dir, 'late.jsonl'), lines.join('\n'));
    writeFileSync(
      join(dir, 'prompt.jsonl'),
      JSON.stringify(userLine('/tmp/proj', 'said at once')),
    );

    const rows = await listClaudeSessions({
      profileDir: root,
      cwd: null,
      limit: 10,
    });

    expect(rows.map((row) => row.id)).toEqual(['prompt']);
  });

  it('does not take a SYNTHETIC or REPLAYED line as something the user said', async () => {
    // The CLI injects a synthetic line after a compaction and re-appends
    // replayed ones with `isReplay`. Titling a row with either puts words in
    // the user's mouth — and the same reader feeds `user_message`, so a
    // regression replays injected text as the user's own in the transcript.
    const root = profile([
      {
        dir: 'proj',
        id: 'synthetic',
        lines: [
          {
            ...(userLine('/tmp/proj', 'injected') as object),
            isSynthetic: true,
          },
        ],
      },
      {
        dir: 'proj',
        id: 'replayed',
        lines: [
          { ...(userLine('/tmp/proj', 'replayed') as object), isReplay: true },
        ],
      },
      { dir: 'proj', id: 'real', lines: [userLine('/tmp/proj', 'typed')] },
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
  it('keeps a character that STRADDLES a 64KB read boundary intact', async () => {
    // The reader pulls 64KB at a time, and a multi-byte character lands on that
    // boundary as arithmetic rather than bad luck: a session of the size this
    // file is built for (11MB) crosses ~170 of them. Decoded per chunk, the
    // straddling character becomes U+FFFD at both ends of the seam — and the
    // line still PARSES, because JSON's own syntax is all ASCII, so the
    // corruption reaches the transcript with nothing anywhere reporting it.
    //
    // The boundary is placed deliberately, not hoped for: everything ahead of
    // the text is ASCII, so its character offset is its byte offset, and the
    // padding is sized to start the first 2-byte character on the last byte of
    // chunk one.
    const CHUNK = 64 * 1024;
    const cwd = '/tmp/proj';
    const head = JSON.stringify(userLine(cwd, '')).indexOf('""}}') + 1;
    const text = `${'a'.repeat(CHUNK - head - 1)}${'я'.repeat(64)}`;
    const root = profile([
      { dir: 'proj', id: 's1', lines: [userLine(cwd, text)] },
    ]);

    const history = await readClaudeSessionHistory({
      profileDir: root,
      sessionId: 's1',
      limit: 100,
    });

    expect(history?.events).toEqual([{ type: 'user_message', text }]);
  });

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

  it('refuses an id that would climb out of the profile', async () => {
    // The id reaches a PATH now — the lookup joins it rather than matching it
    // against a scan — and it arrives over HTTP. A separator in it is refused
    // rather than resolved, so `../../../etc/passwd` cannot name a file the
    // profile does not hold.
    const root = profile([
      { dir: 'proj', id: 's1', lines: [userLine('/tmp/proj', 'hi')] },
    ]);
    const outside = join(root, 'projects', 'escaped');
    mkdirSync(outside, { recursive: true });
    writeFileSync(
      join(outside, 's1.jsonl'),
      JSON.stringify(assistantLine('/tmp/proj', 'should stay unreachable')),
    );

    await expect(
      readClaudeSessionHistory({
        profileDir: root,
        sessionId: '../escaped/s1',
        limit: 100,
      }),
    ).resolves.toBeNull();
  });

  it('finds a session in whichever project directory holds it', async () => {
    // The lookup is now one `stat` per directory rather than a full re-scan of
    // the profile, so it has to try every directory and not just the first.
    const root = profile([
      { dir: 'a', id: 'first', lines: [userLine('/tmp/a', 'one')] },
      { dir: 'b', id: 'second', lines: [assistantLine('/tmp/b', 'two')] },
    ]);

    const history = await readClaudeSessionHistory({
      profileDir: root,
      sessionId: 'second',
      limit: 100,
    });

    expect(history?.events).toEqual([{ type: 'text', text: 'two' }]);
  });
});
