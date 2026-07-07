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

import { readJournal } from '../utils/cursor-mcp-journal';
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
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

function fakeExec(behavior: { gitTracked: boolean }): {
  execFileFn: typeof execFile;
  calls: { cmd: string; args: string[] }[];
} {
  const calls: { cmd: string; args: string[] }[] = [];
  const execFileFn = ((
    cmd: string,
    args: string[],
    _opts: unknown,
    cb: (err: Error | null, stdout: string, stderr: string) => void,
  ) => {
    calls.push({ cmd, args });
    const err =
      cmd === 'git' && !behavior.gitTracked ? new Error('not tracked') : null;
    cb(err, '', '');
    return { kill: vi.fn(), once: vi.fn() };
  }) as unknown as typeof execFile;
  return { execFileFn, calls };
}

function build(
  behavior: { gitTracked: boolean },
  overrides: { journalPath?: string; lockWaitMs?: number } = {},
): {
  service: CursorMcpMergeService;
  calls: { cmd: string; args: string[] }[];
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
    // Targeted approval surface: auto-approval bounded to OUR two tools,
    // `mcp enable` scoped to OUR key — and never a blanket --approve-mcps.
    expect(merged.mcpServers.geniro!.autoApprove).toEqual([
      'call_agent',
      'await_agent',
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

  it('a merge that throws (.cursor is a file, not a directory) frees the cwd lock and leaves no journal entry', async () => {
    const cwd = tempDir('merge-notdir-');
    // A FILE named .cursor makes mergeGeniroEntry's mkdirSync throw — an fs
    // failure on the merge path, after the lock and the journal entry.
    writeFileSync(join(cwd, '.cursor'), 'a file, not a directory', 'utf8');

    const { service, journalPath } = build(
      { gitTracked: false },
      { lockWaitMs: 40 },
    );
    // Refuse or reject — either is acceptable; what must NOT happen is a
    // permanently held lock or a stranded journal entry.
    await service.acquire(cwd, ENDPOINT).catch(() => undefined);

    // No merge happened, so nothing may be journaled for this cwd — a stale
    // created:true entry would make the boot reconcile DELETE a real
    // .cursor/mcp.json the user creates there later.
    expect(readJournal(journalPath)).toHaveLength(0);

    // The fs obstacle is gone and nobody holds the cwd — the next turn must
    // acquire instead of timing out behind a ghost holder.
    rmSync(join(cwd, '.cursor'), { force: true });
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
});
