import type { execFile } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { addJournalEntry, readJournal } from '../utils/cursor-mcp-journal';
import { CursorMcpMergeService } from './cursor-mcp-merge.service';
import { ProcessRegistry } from './process-registry';

const ENDPOINT = {
  url: 'http://127.0.0.1:4870/v1/mcp/run-1/orch',
  token: 'tok-1',
};

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

function fakeExec(behavior: { gitTracked: boolean }): {
  execFileFn: typeof execFile;
  calls: { cmd: string; args: string[]; env?: NodeJS.ProcessEnv }[];
} {
  const calls: {
    cmd: string;
    args: string[];
    env?: NodeJS.ProcessEnv;
  }[] = [];
  const execFileFn = ((
    cmd: string,
    args: string[],
    opts: { env?: NodeJS.ProcessEnv },
    cb: (err: Error | null, stdout: string, stderr: string) => void,
  ) => {
    calls.push({ cmd, args, env: opts.env });
    const err =
      cmd === 'git' && !behavior.gitTracked ? new Error('not tracked') : null;
    cb(err, '', '');
    return { kill: vi.fn(), once: vi.fn() };
  }) as unknown as typeof execFile;
  return { execFileFn, calls };
}

function build(
  behavior: { gitTracked: boolean },
  overrides: {
    journalPath?: string;
    lockWaitMs?: number;
    restoreFn?: () => boolean;
  } = {},
): {
  service: CursorMcpMergeService;
  calls: { cmd: string; args: string[]; env?: NodeJS.ProcessEnv }[];
  journalPath: string;
} {
  const journalPath =
    overrides.journalPath ??
    join(tempDir('cursor-merge-spec-'), 'journal.json');
  const { execFileFn, calls } = fakeExec(behavior);
  const service = new CursorMcpMergeService(new ProcessRegistry(), {
    journalPath,
    lockWaitMs: overrides.lockWaitMs ?? 5_000,
    execFileFn,
    restoreFn: overrides.restoreFn,
  });
  return { service, calls, journalPath };
}

function configPath(cwd: string): string {
  return join(cwd, '.cursor', 'mcp.json');
}

describe('CursorMcpMergeService', () => {
  it('merges for the turn, enables only the geniro key, and release restores everything', async () => {
    const cwd = tempDir('merge-cwd-');
    mkdirSync(join(cwd, '.cursor'), { recursive: true });
    const original = JSON.stringify({ mcpServers: { mine: { command: 'x' } } });
    writeFileSync(configPath(cwd), original, 'utf8');
    chmodSync(configPath(cwd), 0o644);

    const { service, calls, journalPath } = build({ gitTracked: false });
    const result = await service.acquire(cwd, ENDPOINT);
    expect(result.ok).toBe(true);

    const merged = JSON.parse(readFileSync(configPath(cwd), 'utf8')) as {
      mcpServers: Record<
        string,
        { headers?: Record<string, string>; autoApprove?: string[] }
      >;
    };
    expect(merged.mcpServers.geniro!.headers).toEqual({
      Authorization: 'Bearer tok-1',
    });
    expect(merged.mcpServers.mine).toEqual({ command: 'x' });
    // The token-bearing file is owner-only while the turn runs.
    expect(statSync(configPath(cwd)).mode & 0o777).toBe(0o600);
    // Targeted approval surface: auto-approval bounded to OUR call tools
    // (incl. answer_agent — a cursor caller must be able to answer a parked
    // question), `mcp enable` scoped to OUR key — never a blanket
    // --approve-mcps.
    expect(merged.mcpServers.geniro!.autoApprove).toEqual([
      'call_agent',
      'await_agent',
      'answer_agent',
    ]);
    expect(calls.map((c) => c.args)).toContainEqual([
      'mcp',
      'enable',
      'geniro',
    ]);
    expect(calls.every((c) => !c.args.includes('--approve-mcps'))).toBe(true);
    expect(readJournal(journalPath)).toHaveLength(1);

    (result as { release: () => void }).release();
    expect(readFileSync(configPath(cwd), 'utf8')).toBe(original);
    // The user's original mode comes back with the content.
    expect(statSync(configPath(cwd)).mode & 0o777).toBe(0o644);
    expect(readJournal(journalPath)).toHaveLength(0);
    // The lock is freed: a follow-up acquire on the same cwd succeeds at once.
    const again = await service.acquire(cwd, ENDPOINT);
    expect(again.ok).toBe(true);
    (again as { release: () => void }).release();
  });

  it('reports gitTracked from a real git ls-files check', async () => {
    const cwd = tempDir('merge-git-');
    const tracked = build({ gitTracked: true });
    const result = await tracked.service.acquire(cwd, ENDPOINT);
    expect(result).toMatchObject({ ok: true, gitTracked: true });
    (result as { release: () => void }).release();

    const untracked = build({ gitTracked: false });
    const result2 = await untracked.service.acquire(cwd, ENDPOINT);
    expect(result2).toMatchObject({ ok: true, gitTracked: false });
    (result2 as { release: () => void }).release();
  });

  it('strips daemon-only GENIRO_ values from enable and git utility children', async () => {
    vi.stubEnv('GENIRO_CURSOR_API_KEY', 'must-not-leak');
    vi.stubEnv('NORMAL_VAR', 'keep-me');
    const cwd = tempDir('merge-env-');
    const { service, calls } = build({ gitTracked: true });

    const result = await service.acquire(cwd, ENDPOINT);
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.env?.NORMAL_VAR).toBe('keep-me');
      expect(call.env?.GENIRO_CURSOR_API_KEY).toBeUndefined();
    }
    (result as { release: () => void }).release();
  });

  it('refuses a foreign geniro entry, clears the journal, and frees the lock', async () => {
    const cwd = tempDir('merge-conflict-');
    mkdirSync(join(cwd, '.cursor'), { recursive: true });
    const original = JSON.stringify({
      mcpServers: { geniro: { command: 'theirs' } },
    });
    writeFileSync(configPath(cwd), original, 'utf8');

    const { service, journalPath } = build({ gitTracked: false });
    const result = await service.acquire(cwd, ENDPOINT);
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toContain('not ours');
    expect(readFileSync(configPath(cwd), 'utf8')).toBe(original);
    expect(readJournal(journalPath)).toHaveLength(0);
    // Lock freed despite the refusal.
    const retry = await service.acquire(cwd, ENDPOINT);
    expect(retry.ok).toBe(false);
  });

  it('a merge refusal frees the lock and clears its harmless journal entry', async () => {
    const cwd = tempDir('merge-notdir-');
    // A FILE named .cursor makes mergeGeniroEntry's mkdirSync throw — an fs
    // failure on the merge path, after the lock and the journal entry.
    writeFileSync(join(cwd, '.cursor'), 'a file, not a directory', 'utf8');

    const { service, journalPath } = build(
      { gitTracked: false },
      { lockWaitMs: 40 },
    );
    // The no-follow preflight refuses before any file mutation, so this journal
    // entry is harmless and can be cleared while the lock is freed.
    await service.acquire(cwd, ENDPOINT).catch(() => undefined);
    expect(readJournal(journalPath)).toHaveLength(0);

    // The fs obstacle is gone and nobody holds the cwd — the next turn must
    // acquire instead of timing out behind a ghost holder.
    rmSync(join(cwd, '.cursor'), { force: true });
    expect(service.reconcileStranded()).toBe(0);
    expect(readJournal(journalPath)).toHaveLength(0);
    const retry = await service.acquire(cwd, ENDPOINT);
    expect(retry.ok).toBe(true);
    (retry as { release: () => void }).release();
  });

  it('degrades with a lock-timeout reason while another turn holds the cwd', async () => {
    const cwd = tempDir('merge-lock-');
    const { service } = build({ gitTracked: false }, { lockWaitMs: 30 });
    const first = await service.acquire(cwd, ENDPOINT);
    expect(first.ok).toBe(true);

    const second = await service.acquire(cwd, ENDPOINT);
    expect(second.ok).toBe(false);
    expect((second as { reason: string }).reason).toContain('holding');

    (first as { release: () => void }).release();
  });

  it('boot reconcile restores a merge stranded by SIGKILL (release never ran)', async () => {
    const cwd = tempDir('merge-strand-');
    mkdirSync(join(cwd, '.cursor'), { recursive: true });
    const original = JSON.stringify({ mcpServers: {} });
    writeFileSync(configPath(cwd), original, 'utf8');
    chmodSync(configPath(cwd), 0o644);

    const journalPath = join(tempDir('merge-strand-journal-'), 'journal.json');
    const killed = build({ gitTracked: false }, { journalPath });
    const held = await killed.service.acquire(cwd, ENDPOINT);
    expect(held.ok).toBe(true);
    // SIGKILL: the daemon dies here — release() never runs.

    // Next daemon launch: a FRESH service instance over the same journal.
    const next = build({ gitTracked: false }, { journalPath });
    expect(next.service.reconcileStranded()).toBe(1);
    expect(readFileSync(configPath(cwd), 'utf8')).toBe(original);
    // The journaled original mode survives the crash round-trip too.
    expect(statSync(configPath(cwd)).mode & 0o777).toBe(0o644);
    expect(readJournal(journalPath)).toHaveLength(0);
  });

  it('boot reconcile deletes a stranded file geniro itself created', async () => {
    const cwd = tempDir('merge-strand-created-');
    const journalPath = join(tempDir('merge-strand-journal2-'), 'journal.json');
    const killed = build({ gitTracked: false }, { journalPath });
    const held = await killed.service.acquire(cwd, ENDPOINT);
    expect(held.ok).toBe(true);
    expect(existsSync(configPath(cwd))).toBe(true);

    const next = build({ gitTracked: false }, { journalPath });
    expect(next.service.reconcileStranded()).toBe(1);
    expect(existsSync(configPath(cwd))).toBe(false);
  });

  it('retains the journal entry when settle-time restore fails', async () => {
    const cwd = tempDir('merge-restore-fail-');
    const journalPath = join(tempDir('merge-restore-journal-'), 'journal.json');
    const restoreFn = vi.fn(() => false);
    const { service } = build(
      { gitTracked: false },
      { journalPath, restoreFn },
    );
    const result = await service.acquire(cwd, ENDPOINT);
    expect(result.ok).toBe(true);

    (result as { release: () => void }).release();

    expect(restoreFn).toHaveBeenCalledOnce();
    expect(readJournal(journalPath)).toHaveLength(1);
  });

  it('keeps the original recovery entry when a new acquire follows a failed restore', async () => {
    const cwd = tempDir('merge-restore-retry-');
    const journalPath = join(
      tempDir('merge-restore-retry-journal-'),
      'journal.json',
    );
    const { service } = build(
      { gitTracked: false },
      { journalPath, restoreFn: () => false },
    );
    const first = await service.acquire(cwd, ENDPOINT);
    expect(first.ok).toBe(true);
    (first as { release: () => void }).release();

    const retry = await service.acquire(cwd, ENDPOINT);
    expect(retry.ok).toBe(false);

    expect(readJournal(journalPath)).toEqual([
      expect.objectContaining({ cwd, created: true }),
    ]);
  });

  it('retains a stranded entry when boot reconciliation cannot restore it', () => {
    const cwd = tempDir('merge-reconcile-fail-');
    const journalPath = join(
      tempDir('merge-reconcile-journal-'),
      'journal.json',
    );
    addJournalEntry(journalPath, {
      cwd,
      created: true,
      ts: Date.now(),
    });
    const { service } = build(
      { gitTracked: false },
      { journalPath, restoreFn: () => false },
    );

    expect(service.reconcileStranded()).toBe(0);
    expect(readJournal(journalPath)).toHaveLength(1);
  });
});
