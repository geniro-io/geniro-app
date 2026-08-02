import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { cleanStrandedMerge } from './cursor-mcp-cleanup';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A worktree with a `.cursor` directory and nothing in it yet. */
function worktree(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'cursor-clean-'));
  dirs.push(cwd);
  mkdirSync(join(cwd, '.cursor'));
  return cwd;
}

function configPath(cwd: string): string {
  return join(cwd, '.cursor', 'mcp.json');
}

function readJson(path: string): { mcpServers?: Record<string, unknown> } {
  return JSON.parse(readFileSync(path, 'utf8')) as {
    mcpServers?: Record<string, unknown>;
  };
}

describe('cleanStrandedMerge', () => {
  it('leaves an mcpServers.geniro entry the merge never wrote where it is', () => {
    // A journal entry can outlive the merge it described: the entry is written
    // BEFORE the file is touched, and the merge that follows REFUSES a file
    // that already carries a foreign `geniro` key. A crash (or a lost journal
    // update across two cwds) in that window leaves a `created: false` entry
    // naming a worktree whose `geniro` server is the user's own. The absent
    // `.geniro-bak` proves it: a real merge into an existing file always
    // copied the original there first.
    const cwd = worktree();
    const theirs = { command: 'their-own-geniro-mcp', args: ['--stdio'] };
    writeFileSync(
      configPath(cwd),
      JSON.stringify({ mcpServers: { geniro: theirs } }),
      'utf8',
    );

    cleanStrandedMerge(cwd, { created: false, mode: 0o644 });

    expect(readJson(configPath(cwd)).mcpServers).toEqual({ geniro: theirs });
  });

  it('deletes the shell it created even when its own entry is already gone', () => {
    // A restore that wrote the stripped file but died before clearing the
    // journal leaves exactly this: a geniro-CREATED file reduced to the empty
    // shell, still journalled. Removing our key from it leaves the shell —
    // the module's own condition for deleting a file it created — so the
    // stray file must not survive the retry.
    const cwd = worktree();
    writeFileSync(
      configPath(cwd),
      JSON.stringify({ mcpServers: {} }, null, 2),
      'utf8',
    );

    expect(cleanStrandedMerge(cwd, { created: true })).toBe('cleaned');
    expect(existsSync(configPath(cwd))).toBe(false);
  });

  it("restores the user's original bytes when the stripped file matches the backup", () => {
    // The merge rewrote the user's file as 2-space JSON and parked the
    // original bytes in `.geniro-bak`. Nothing was edited since, so stripping
    // our key reproduces the backup's content exactly — putting the ORIGINAL
    // bytes back is what keeps the user's indentation (and their git diff)
    // out of the blast radius.
    const cwd = worktree();
    const original =
      '{\n    "mcpServers": {\n        "their-server": {\n            "command": "their-mcp"\n        }\n    }\n}\n';
    writeFileSync(`${configPath(cwd)}.geniro-bak`, original, 'utf8');
    writeFileSync(
      configPath(cwd),
      JSON.stringify(
        {
          mcpServers: {
            'their-server': { command: 'their-mcp' },
            geniro: {
              url: 'http://127.0.0.1:1/v1/mcp/r/n',
              headers: { Authorization: 'Bearer dead-token' },
              autoApprove: ['call_agent'],
            },
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    cleanStrandedMerge(cwd, { created: false, mode: 0o644 });

    expect(readFileSync(configPath(cwd), 'utf8')).toBe(original);
  });

  it('refuses every symlinked path rather than following it off the worktree', () => {
    // Each of these would let a cleanup running at daemon boot write to, or
    // delete, a file outside the directory the journal actually named.
    const sentinelDir = mkdtempSync(join(tmpdir(), 'cursor-sentinel-'));
    dirs.push(sentinelDir);
    const sentinel = join(sentinelDir, 'precious.json');
    const sentinelBytes = JSON.stringify({ mcpServers: { geniro: 'theirs' } });
    writeFileSync(sentinel, sentinelBytes, 'utf8');

    // 1. `.cursor` itself is a link.
    const linkedDir = mkdtempSync(join(tmpdir(), 'cursor-linkdir-'));
    dirs.push(linkedDir);
    symlinkSync(sentinelDir, join(linkedDir, '.cursor'));
    expect(cleanStrandedMerge(linkedDir, { created: false })).toBe(
      'unresolved',
    );

    // 2. `mcp.json` is a link into someone else's file.
    const linkedFile = worktree();
    symlinkSync(sentinel, configPath(linkedFile));
    expect(cleanStrandedMerge(linkedFile, { created: true })).toBe(
      'unresolved',
    );

    // 3. The backup is a link — restore would copy over the target.
    const linkedBak = worktree();
    writeFileSync(
      configPath(linkedBak),
      JSON.stringify({ mcpServers: {} }),
      'utf8',
    );
    symlinkSync(sentinel, `${configPath(linkedBak)}.geniro-bak`);
    expect(cleanStrandedMerge(linkedBak, { created: false })).toBe(
      'unresolved',
    );

    // Nothing outside the named worktrees was read, rewritten or removed.
    expect(readFileSync(sentinel, 'utf8')).toBe(sentinelBytes);
  });

  it('leaves an unparseable file and its backup alone instead of guessing', () => {
    const cwd = worktree();
    // The likeliest reason a `.cursor/mcp.json` stops parsing is the user's
    // own edit, and by now the backup can be weeks old — copying it over
    // would silently discard whatever they added since.
    writeFileSync(configPath(cwd), '{ "mcpServers": {}, // theirs\n}', 'utf8');
    const backup = `${configPath(cwd)}.geniro-bak`;
    writeFileSync(backup, JSON.stringify({ mcpServers: {} }), 'utf8');

    expect(cleanStrandedMerge(cwd, { created: false, mode: 0o644 })).toBe(
      'unresolved',
    );
    expect(readFileSync(configPath(cwd), 'utf8')).toContain('// theirs');
    expect(existsSync(backup)).toBe(true);
  });
});
