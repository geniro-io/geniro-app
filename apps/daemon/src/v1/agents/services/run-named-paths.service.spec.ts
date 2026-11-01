import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';

import type { MikroORM } from '@mikro-orm/sqlite';
import { NotFoundException } from '@packages/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { chatSearchDb } from '../__tests__/chat-search-db';
import { ItemDao } from '../dao/item.dao';
import { RunDao } from '../dao/run.dao';
import { ItemSeqAllocator } from './item-seq.allocator';
import { RunNamedPathsService } from './run-named-paths.service';

const REPO = '/repo';
const OWN = '/repo/.claude/worktrees/cw-1256-padding';
const SIBLING = '/repo/.claude/worktrees/cw-1257-copy';

let db: Awaited<ReturnType<typeof chatSearchDb>>;
let orm: MikroORM;
let seq = 0;

/** A Bash tool call, persisted the way the persist seam writes one. */
const ranCommand = (
  runId: string,
  command: string,
  kind = 'tool_call',
  at = (seq += 1),
) =>
  db.item(`item-${at}`, {
    runId,
    seq: at,
    kind: kind as 'tool_call',
    role: null,
    payload: JSON.stringify({
      id: `toolu_${at}`,
      name: 'Bash',
      input: { command },
    }),
  });

const service = (itemDao = new ItemDao(orm.em.fork())): RunNamedPathsService =>
  new RunNamedPathsService(
    orm.em.fork(),
    itemDao,
    new RunDao(orm.em.fork()),
    new ItemSeqAllocator(orm.em.fork(), itemDao),
  );

beforeEach(async () => {
  db = await chatSearchDb();
  orm = db.orm;
  seq = 0;
  await db.run('run-a', { cwd: REPO });
  await db.run('run-b', { cwd: REPO });
});

afterEach(async () => {
  await orm.close(true);
});

describe('RunNamedPathsService', () => {
  it('names the worktree its own tool calls work in, and not one only another thread of the same repository names', async () => {
    // Two teams on one repository, each with its own worktree: the
    // repository lists both, and each thread must claim only its own.
    await ranCommand('run-a', `cd ${OWN} && pnpm test`);
    await ranCommand('run-b', `git -C ${SIBLING} status`);

    expect(await service().named('run-a', [OWN, SIBLING])).toEqual({
      named: [OWN],
    });
  });

  it('does not take a folder whose path only begins another named one', async () => {
    await ranCommand('run-a', `cat ${OWN}-v2/README.md`);

    expect(await service().named('run-a', [OWN])).toEqual({ named: [] });
  });

  it('never claims the folder the run works in, or one holding it', async () => {
    // From inside a worktree nested in the checkout, every path the thread
    // touches begins with the checkout's own path.
    await db.run('run-nested', { cwd: OWN });
    await ranCommand('run-nested', `cat ${OWN}/src/a.ts`);

    expect(await service().named('run-nested', [REPO, OWN])).toEqual({
      named: [],
    });
  });

  it('names a worktree the calls spell relative to the run’s folder', async () => {
    await ranCommand(
      'run-a',
      'git worktree add -b cw-1256 .claude/worktrees/cw-1256-padding origin/main',
    );

    expect(await service().named('run-a', [OWN])).toEqual({ named: [OWN] });
  });

  it('does not take a relative name found inside another repository’s path', async () => {
    // Two repositories can both have a `.claude/worktrees/cw-1256-padding`; a
    // call naming the other one's is no evidence about this one.
    await ranCommand(
      'run-a',
      'ls /elsewhere/.claude/worktrees/cw-1256-padding/src',
    );

    expect(await service().named('run-a', [OWN])).toEqual({ named: [] });
  });

  it('names a worktree spelled relatively at the start of a line or after a tab', async () => {
    // Stored as JSON text, a newline before the path is `\n` — two characters
    // whose second is a letter, not a word boundary.
    await ranCommand(
      'run-a',
      'git status\n.claude/worktrees/cw-1256-padding/run.sh',
    );
    await ranCommand('run-b', 'ls\t.claude/worktrees/cw-1257-copy/');

    expect(await service().named('run-a', [OWN])).toEqual({ named: [OWN] });
    expect(await service().named('run-b', [SIBLING])).toEqual({
      named: [SIBLING],
    });
  });

  it('names a worktree spelled `./`-relative', async () => {
    await ranCommand('run-a', 'cd ./.claude/worktrees/cw-1256-padding && ls');

    expect(await service().named('run-a', [OWN])).toEqual({ named: [OWN] });
  });

  it('does not count a one-segment relative name, which any command could hold', async () => {
    await ranCommand('run-a', 'cd wt && ls');

    expect(await service().named('run-a', ['/repo/wt'])).toEqual({
      named: [],
    });
  });

  it('names a worktree spelled relatively when the run’s folder is a symlink', async () => {
    // git lists worktrees by real path, so the relative form has to be taken
    // from the resolved folder as well as the folder as stored.
    const real = realpathSync(mkdtempSync(join(tmpdir(), 'geniro-named-')));
    const link = `${real}-link`;
    try {
      mkdirSync(join(real, '.claude/worktrees/x'), { recursive: true });
      symlinkSync(real, link);
      await db.run('run-link', { cwd: link });
      await ranCommand('run-link', 'cd .claude/worktrees/x && git status');

      expect(
        await service().named('run-link', [join(real, '.claude/worktrees/x')]),
      ).toEqual({ named: [join(real, '.claude/worktrees/x')] });
    } finally {
      rmSync(link, { force: true });
      rmSync(real, { recursive: true, force: true });
    }
  });

  it('matches an asked path literally — `_` is no wildcard, and case counts', async () => {
    await ranCommand('run-a', 'ls /repo/wtXa/src && ls /Repo/WT_B/src');

    expect(
      await service().named('run-a', ['/repo/wt_a', '/repo/wt_b']),
    ).toEqual({ named: [] });
  });

  it('counts only what the run’s tool calls name, not a listing a result printed', async () => {
    // `git worktree list` prints every worktree of the repository — a result
    // naming a folder says nothing about the thread having worked there.
    await ranCommand(
      'run-a',
      `worktree ${SIBLING}\nbranch refs/heads/x`,
      'tool_result',
    );
    // A call after it, so the read covers the result's seq.
    await ranCommand('run-a', 'ls');

    expect(await service().named('run-a', [SIBLING])).toEqual({ named: [] });
  });

  it('reads the whole history for a folder first asked about after an earlier answer', async () => {
    // The renderer asks in batches: the first moves the run's reading to its
    // newest call, so a later batch's folders are only found in what came before.
    const named = service();
    await ranCommand('run-a', `cd ${SIBLING}`, 'tool_call', 10);
    expect(await named.named('run-a', [OWN])).toEqual({ named: [] });

    expect(await named.named('run-a', [OWN, SIBLING])).toEqual({
      named: [SIBLING],
    });
  });

  it('answers two overlapping asks for one run alike, and keeps what they found', async () => {
    // A desktop window and a paired phone ask at one turn end: neither may
    // record a folder the thread named as not named. The reading is at seq 10
    // (an earlier ask about another folder) and OWN is first named after it;
    // the first ask is held inside its read of the history while the second
    // is given every chance to run to the end.
    const itemDao = new ItemDao(orm.em.fork());
    const named = service(itemDao);
    await ranCommand('run-a', 'ls', 'tool_call', 10);
    await named.named('run-a', [SIBLING]);
    await ranCommand('run-a', `cd ${OWN}`, 'tool_call', 20);

    const read = itemDao.toolCallsContainingAny.bind(itemDao);
    let reached: () => void = () => {};
    const atRead = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(itemDao, 'toolCallsContainingAny').mockImplementationOnce(
      async (...args) => {
        reached();
        await held;
        return read(...args);
      },
    );
    const first = named.named('run-a', [OWN]);
    await atRead;
    const second = named.named('run-a', [OWN]);
    for (let turn = 0; turn < 20; turn += 1) {
      await setImmediate();
    }
    release();

    expect(await first).toEqual({ named: [OWN] });
    expect(await second).toEqual({ named: [OWN] });
    expect(await named.named('run-a', [OWN])).toEqual({ named: [OWN] });
  });

  it('reads a call written late below the newest one, instead of passing it by for good', async () => {
    // Seq 20 is reserved and still being written while 21 is already on disk.
    // A reading that moved past 20 would never read it again.
    const itemDao = new ItemDao(orm.em.fork());
    const seqs = new ItemSeqAllocator(orm.em.fork(), itemDao);
    const named = new RunNamedPathsService(
      orm.em.fork(),
      itemDao,
      new RunDao(orm.em.fork()),
      seqs,
    );
    await ranCommand('run-a', 'ls', 'tool_call', 19);
    const reserved = await seqs.reserve('run-a');
    expect(reserved).toBe(20);
    await ranCommand('run-a', 'ls', 'tool_call', 21);
    expect(await named.named('run-a', [OWN])).toEqual({ named: [] });

    await ranCommand('run-a', `cd ${OWN}`, 'tool_call', reserved);
    seqs.settle('run-a', reserved);

    expect(await named.named('run-a', [OWN])).toEqual({ named: [OWN] });
  });

  it('finds a call far past the first window of a long thread', async () => {
    await ranCommand('run-a', 'ls', 'tool_call', 1);
    await ranCommand('run-a', `cd ${OWN}`, 'tool_call', 4_500);

    expect(await service().named('run-a', [OWN])).toEqual({ named: [OWN] });
  });

  it('reads only the calls written since its last answer, and still finds one named there', async () => {
    const itemDao = new ItemDao(orm.em.fork());
    const reads = vi.spyOn(itemDao, 'toolCallsContainingAny');
    const named = service(itemDao);
    await ranCommand('run-a', 'ls', 'tool_call', 10);
    expect(await named.named('run-a', [OWN])).toEqual({ named: [] });

    reads.mockClear();
    await ranCommand('run-a', `cd ${OWN}`, 'tool_call', 11);
    expect(await named.named('run-a', [OWN])).toEqual({ named: [OWN] });
    expect(
      reads.mock.calls.map(([, after, through]) => [after, through]),
    ).toEqual([[10, 11]]);
  });

  it('refuses a run that does not exist', async () => {
    await expect(service().named('run-missing', [OWN])).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
