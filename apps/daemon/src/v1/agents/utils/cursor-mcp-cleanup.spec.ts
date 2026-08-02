import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
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

/** The entry the deleted merge actually wrote — see `isOurEntry`. */
function ourEntry(): Record<string, unknown> {
  return {
    url: 'http://127.0.0.1:47615/v1/mcp/run-1/orch',
    headers: { Authorization: 'Bearer tok-1' },
    autoApprove: ['call_agent', 'await_agent', 'answer_agent'],
  };
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

    // `foreign` — not `failed` — is what tells the caller to stop retrying:
    // this file will never become ours, so retrying forever would keep the
    // module and its boot warning alive past the release that removes them.
    expect(cleanStrandedMerge(cwd, { created: false, mode: 0o644 })).toBe(
      'foreign',
    );
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

  it("puts the user's file mode back even when the geniro key is already gone", () => {
    // Same crash window as the test above — the old restore wrote the stripped
    // file and died before chmod'ing it back. The merge left the file 0600
    // because it carried a bearer call token; the journal records the user's
    // own mode precisely so cleanup can put it back. Reporting `cleaned` and
    // dropping the entry while the file stays 0600 makes geniro's permission
    // change on a file in the user's repo permanent, with nothing left that
    // will ever revisit it.
    const cwd = worktree();
    writeFileSync(
      configPath(cwd),
      JSON.stringify({ mcpServers: { 'their-server': { command: 'x' } } }),
      'utf8',
    );
    chmodSync(configPath(cwd), 0o600);

    expect(cleanStrandedMerge(cwd, { created: false, mode: 0o644 })).toBe(
      'cleaned',
    );
    expect(statSync(configPath(cwd)).mode & 0o777).toBe(0o644);
  });

  it('keeps a geniro-created file the user emptied by hand rather than deleting it', () => {
    // A created file may be deleted only when removing our key leaves exactly
    // the shell geniro itself wrote (`{"mcpServers":{}}`) — anything else is
    // the user's. `{}` is not that shell: the user replaced the content. The
    // shell comparison runs on `{...parsed, mcpServers}`, which SYNTHESISES an
    // empty `mcpServers` into any file that has none, so a file geniro never
    // wrote passes the test — and a created file has no `.geniro-bak`, so the
    // delete cannot be undone.
    const cwd = worktree();
    writeFileSync(configPath(cwd), '{}', 'utf8');

    cleanStrandedMerge(cwd, { created: true });

    expect(existsSync(configPath(cwd))).toBe(true);
    expect(readFileSync(configPath(cwd), 'utf8')).toBe('{}');
  });

  it('does not call a worktree clean while the worktree itself is absent', () => {
    // The repo lives on a volume that is not mounted at daemon boot (an
    // external disk, a network share, a login-time race). Every lstat below
    // the missing cwd reports ENOENT, which reads identically to "the user
    // deleted their mcp.json" — so the entry is reported cleaned and dropped,
    // and the residue in that repo is never touched again. A genuinely deleted
    // repo is served just as well by retrying: those entries age out.
    const parent = mkdtempSync(join(tmpdir(), 'cursor-unmounted-'));
    dirs.push(parent);
    const cwd = join(parent, 'repo-on-an-unmounted-volume');

    expect(cleanStrandedMerge(cwd, { created: false, mode: 0o644 })).toBe(
      'failed',
    );
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

  it.each([
    ['.cursor is a link', 'cursorDir'],
    ['mcp.json is a link', 'config'],
    ['the backup is a link', 'backup'],
  ] as const)(
    'refuses to follow a symlink off the worktree — %s',
    (_label, shape) => {
      // The sentinel is a REAL geniro-shaped merge in someone else's repo, so
      // following any of these links would genuinely rewrite or delete it —
      // which is what makes the byte assertion below load-bearing rather than
      // decorative.
      const sentinelDir = mkdtempSync(join(tmpdir(), 'cursor-sentinel-'));
      dirs.push(sentinelDir);
      const sentinel = join(sentinelDir, 'mcp.json');
      const sentinelBytes = JSON.stringify({
        mcpServers: { geniro: ourEntry(), theirs: { command: 'theirs' } },
      });
      writeFileSync(sentinel, sentinelBytes, 'utf8');

      const cwd = mkdtempSync(join(tmpdir(), 'cursor-link-'));
      dirs.push(cwd);
      if (shape === 'cursorDir') {
        symlinkSync(sentinelDir, join(cwd, '.cursor'));
      } else {
        mkdirSync(join(cwd, '.cursor'));
        if (shape === 'config') {
          symlinkSync(sentinel, configPath(cwd));
        } else {
          writeFileSync(
            configPath(cwd),
            JSON.stringify({ mcpServers: { geniro: ourEntry() } }),
            'utf8',
          );
          symlinkSync(sentinel, `${configPath(cwd)}.geniro-bak`);
        }
      }

      expect(cleanStrandedMerge(cwd, { created: false, mode: 0o644 })).toBe(
        'unresolved',
      );
      expect(readFileSync(sentinel, 'utf8')).toBe(sentinelBytes);
    },
  );

  it('refuses a backup that is not a regular file, without reading it', () => {
    // A FIFO here would block readFileSync forever — inside the pre-listen
    // boot path, where no try/catch can recover from a block.
    const cwd = worktree();
    writeFileSync(
      configPath(cwd),
      JSON.stringify({ mcpServers: { geniro: ourEntry() } }),
      'utf8',
    );
    mkdirSync(`${configPath(cwd)}.geniro-bak`);

    expect(cleanStrandedMerge(cwd, { created: false, mode: 0o644 })).toBe(
      'unresolved',
    );
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
