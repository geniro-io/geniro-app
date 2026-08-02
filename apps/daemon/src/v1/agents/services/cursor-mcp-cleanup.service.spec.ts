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

import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CursorMcpCleanupService } from './cursor-mcp-cleanup.service';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** A worktree whose `.cursor/mcp.json` still carries the stranded merge. */
function strandedWorktree(
  contents: Record<string, unknown>,
  mode?: number,
): string {
  const cwd = tempDir('cursor-wt-');
  mkdirSync(join(cwd, '.cursor'));
  const path = join(cwd, '.cursor', 'mcp.json');
  writeFileSync(path, JSON.stringify(contents), 'utf8');
  if (mode !== undefined) {
    chmodSync(path, mode);
  }
  return cwd;
}

/** Journalled just now, so the age cutoff never fires unless a test wants it. */
function journalOf(
  entries: { cwd: string; created: boolean; mode?: number }[],
): string {
  const path = join(tempDir('cursor-journal-'), 'cursor-mcp-journal.json');
  writeFileSync(
    path,
    JSON.stringify(entries.map((e) => ({ ...e, ts: Date.now() }))),
    'utf8',
  );
  return path;
}

/**
 * The entry the deleted merge actually wrote (`buildCursorMcpServerEntry`).
 * Cleanup only strips a `geniro` key carrying this shape — anything else is
 * the user's own server that happens to share the name.
 */
function ourEntry(): Record<string, unknown> {
  return {
    url: 'http://127.0.0.1:47615/v1/mcp/run-1/orch',
    headers: { Authorization: 'Bearer tok-1' },
    autoApprove: ['call_agent', 'await_agent', 'answer_agent'],
  };
}

/** The per-entry attempt counts the service has recorded so far. */
function attemptsIn(journalPath: string): (number | undefined)[] {
  const entries = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    attempts?: number;
  }[];
  return entries.map((e) => e.attempts);
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

describe('CursorMcpCleanupService', () => {
  it('strips the geniro entry from a user file while keeping their own servers', () => {
    const cwd = strandedWorktree({
      mcpServers: {
        geniro: ourEntry(),
        'their-server': { command: 'their-mcp' },
      },
      someOtherKey: true,
    });
    const config = join(cwd, '.cursor', 'mcp.json');
    // The 0600 the old merge applied for the turn, plus its backup sibling.
    chmodSync(config, 0o600);
    writeFileSync(
      `${config}.geniro-bak`,
      JSON.stringify({
        mcpServers: { 'their-server': { command: 'their-mcp' } },
      }),
      'utf8',
    );
    const journalPath = journalOf([{ cwd, created: false, mode: 0o644 }]);

    const cleaned = new CursorMcpCleanupService({
      journalPath,
    }).reconcileStranded();

    expect(cleaned).toBe(1);
    const after = readJson(config);
    expect(after.mcpServers).toEqual({
      'their-server': { command: 'their-mcp' },
    });
    // Everything of the user's survives — this is surgical, not a revert.
    expect(after.someOtherKey).toBe(true);
    expect(statSync(config).mode & 0o777).toBe(0o644);
    // No residue left anywhere the user can see.
    expect(existsSync(`${config}.geniro-bak`)).toBe(false);
    expect(existsSync(journalPath)).toBe(false);
  });

  it('deletes a file geniro created once its own entry is gone', () => {
    const cwd = strandedWorktree({ mcpServers: { geniro: ourEntry() } });
    const journalPath = journalOf([{ cwd, created: true }]);

    expect(
      new CursorMcpCleanupService({ journalPath }).reconcileStranded(),
    ).toBe(1);

    // Removing our key left exactly the shell geniro wrote — nothing of the
    // user's was ever in this file, so the file itself goes.
    expect(existsSync(join(cwd, '.cursor', 'mcp.json'))).toBe(false);
  });

  it('keeps a geniro-created file the user has since added their own server to', () => {
    const cwd = strandedWorktree({
      mcpServers: {
        geniro: ourEntry(),
        mine: { command: 'mine' },
      },
    });
    const journalPath = journalOf([{ cwd, created: true }]);

    new CursorMcpCleanupService({ journalPath }).reconcileStranded();

    const config = join(cwd, '.cursor', 'mcp.json');
    expect(existsSync(config)).toBe(true);
    expect(readJson(config).mcpServers).toEqual({ mine: { command: 'mine' } });
  });

  it('sweeps a staging file orphaned between the old merge’s write and rename', () => {
    const cwd = strandedWorktree({ mcpServers: {} });
    const tmp = join(cwd, '.cursor', 'mcp.json.geniro-tmp');
    // 0600, and holding a call token that died with its daemon launch.
    writeFileSync(tmp, JSON.stringify({ mcpServers: { geniro: {} } }), {
      encoding: 'utf8',
      mode: 0o600,
    });
    const journalPath = journalOf([{ cwd, created: false, mode: 0o644 }]);

    new CursorMcpCleanupService({ journalPath }).reconcileStranded();

    expect(existsSync(tmp)).toBe(false);
  });

  it('retries a transient failure but reports and drops a settled refusal', () => {
    const good = strandedWorktree({ mcpServers: { geniro: ourEntry() } });
    // `.cursor` is a FILE, not a directory: cleanup will never resolve this,
    // so retrying forever would keep this module alive past its removal
    // release. It is reported once and dropped.
    const settled = tempDir('cursor-settled-');
    writeFileSync(join(settled, '.cursor'), 'not a directory', 'utf8');
    // A cwd that is itself a regular file makes the very first lstat throw —
    // a transient shape worth another launch.
    const transientRoot = tempDir('cursor-transient-');
    const transient = join(transientRoot, 'a-file');
    writeFileSync(transient, 'x', 'utf8');

    const journalPath = journalOf([
      { cwd: good, created: false, mode: 0o644 },
      { cwd: settled, created: false },
      { cwd: transient, created: false },
    ]);

    const cleaned = new CursorMcpCleanupService({
      journalPath,
    }).reconcileStranded();

    expect(cleaned).toBe(1);
    const remaining = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      cwd: string;
    }[];
    expect(remaining.map((e) => e.cwd)).toEqual([transient]);
  });

  it('gives a failing cwd a bounded number of launches, then converges', () => {
    const transientRoot = tempDir('cursor-old-');
    const transient = join(transientRoot, 'a-file');
    writeFileSync(transient, 'x', 'utf8');
    const journalPath = journalOf([{ cwd: transient, created: false }]);
    const service = new CursorMcpCleanupService({ journalPath });

    // Each launch earns one more attempt — the entry survives the first two…
    service.reconcileStranded();
    expect(attemptsIn(journalPath)).toEqual([1]);
    service.reconcileStranded();
    expect(attemptsIn(journalPath)).toEqual([2]);

    // …and the third gives up, so the journal reaches empty and this module
    // can honour its "delete one release after shipping" promise.
    service.reconcileStranded();
    expect(existsSync(journalPath)).toBe(false);
  });

  it('converges even when the journal timestamp is nonsense', () => {
    const transientRoot = tempDir('cursor-future-');
    const transient = join(transientRoot, 'a-file');
    writeFileSync(transient, 'x', 'utf8');
    // `ts` is data read off disk: a clock that was wrong when the merge ran (a
    // VM before its first NTP sync, a restored backup) dates the entry in the
    // future, and an age check would read that as "always young" and retry
    // forever. Give-up is counted, not timed, so no timestamp — future, zero
    // or absent — can buy extra launches.
    const journalPath = join(tempDir('cursor-futurej-'), 'journal.json');
    writeFileSync(
      journalPath,
      JSON.stringify([
        {
          cwd: transient,
          created: false,
          ts: Date.now() + 400 * 24 * 60 * 60 * 1000,
        },
      ]),
      'utf8',
    );
    const service = new CursorMcpCleanupService({ journalPath });

    service.reconcileStranded();
    service.reconcileStranded();
    service.reconcileStranded();

    expect(existsSync(journalPath)).toBe(false);
  });

  it('never lets a write failure escape into the boot sequence', () => {
    const transientRoot = tempDir('cursor-boot-');
    const transient = join(transientRoot, 'a-file');
    writeFileSync(transient, 'x', 'utf8');
    // A journal that PARSES (so the replay actually runs) and holds an entry
    // that will be retained (so the rewrite is reached), with the staging
    // sibling occupied by a directory — `rmSync` without `recursive` throws
    // EISDIR there, from inside `writeMergeJournal`.
    const journalPath = journalOf([{ cwd: transient, created: false }]);
    mkdirSync(`${journalPath}.tmp`);
    const service = new CursorMcpCleanupService({ journalPath });
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => {});

    // This runs pre-listen: an escaping error exits the process before the
    // pidfile is written, and repeats every launch — a one-release hygiene
    // task must never be able to cost the user their daemon.
    expect(() => service.reconcileStranded()).not.toThrow();
    expect(
      warn.mock.calls.some((call) =>
        String(call[0]).includes('cursor MCP cleanup skipped'),
      ),
    ).toBe(true);
    warn.mockRestore();
  });

  it('does nothing at all when no journal exists — the common upgrade path', () => {
    const journalPath = join(tempDir('cursor-none-'), 'absent.json');
    expect(
      new CursorMcpCleanupService({ journalPath }).reconcileStranded(),
    ).toBe(0);
    expect(existsSync(journalPath)).toBe(false);
  });
});
