import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentRepoInstructions } from '../adapters/adapter.types';
import {
  importsOf,
  measureRepoInstructionFiles,
  namesPaths,
} from './repo-instruction-files';

const CLAUDE_LIKE: AgentRepoInstructions = {
  kind: 'files',
  fileNames: ['CLAUDE.md', 'CLAUDE.local.md', '.claude/CLAUDE.md'],
  rulesDir: '.claude/rules',
  atImports: true,
};

describe('measureRepoInstructionFiles', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'geniro-repo-files-'));
    await mkdir(join(repo, '.git'));
    await mkdir(join(repo, 'apps', 'daemon'), { recursive: true });
    await mkdir(join(repo, '.claude', 'rules', 'nested'), { recursive: true });
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('walks from the repository root to the folder, follows @-imports once and loads rules without paths', async () => {
    await writeFile(join(repo, 'CLAUDE.md'), '@AGENTS.md\n');
    await writeFile(
      join(repo, 'AGENTS.md'),
      'Rules. Import as `@packages/common`. Mail a@b.c. See @docs/extra.md and @CLAUDE.md.\n',
    );
    await mkdir(join(repo, 'docs'));
    await writeFile(join(repo, 'docs', 'extra.md'), 'x'.repeat(40));
    await writeFile(join(repo, 'apps', 'daemon', 'CLAUDE.md'), 'daemon rules');
    await writeFile(join(repo, '.claude', 'rules', 'always.md'), '# Always\n');
    await writeFile(
      join(repo, '.claude', 'rules', 'nested', 'scoped.md'),
      '---\ndescription: x\npaths:\n  - apps/**\n---\n# Scoped\n',
    );

    const measured = await measureRepoInstructionFiles(
      CLAUDE_LIKE,
      join(repo, 'apps', 'daemon'),
      '/home/nobody',
    );

    if (measured.kind !== 'measured') {
      throw new Error(measured.reason);
    }
    expect(measured.root).toBe(repo);
    expect(
      measured.files.map((file) => [
        file.path.slice(repo.length + 1),
        file.importedFrom?.slice(repo.length + 1) ?? null,
      ]),
    ).toEqual([
      ['CLAUDE.md', null],
      ['AGENTS.md', 'CLAUDE.md'],
      ['docs/extra.md', 'AGENTS.md'],
      ['apps/daemon/CLAUDE.md', null],
      ['.claude/rules/always.md', null],
    ]);
    expect(measured.files[2]).toMatchObject({ chars: 40, approxTokens: 10 });
    expect(measured.chars).toBe(
      measured.files.reduce((sum, file) => sum + file.chars!, 0),
    );
  });

  it('follows imports five deep and passes over one naming no file', async () => {
    await writeFile(join(repo, 'CLAUDE.md'), '@f1.md @missing.md');
    for (let depth = 1; depth <= 7; depth += 1) {
      await writeFile(join(repo, `f${depth}.md`), `@f${depth + 1}.md`);
    }

    const measured = await measureRepoInstructionFiles(CLAUDE_LIKE, repo);

    if (measured.kind !== 'measured') {
      throw new Error(measured.reason);
    }
    expect(
      measured.files.map((file) => file.path.slice(repo.length + 1)),
    ).toEqual(['CLAUDE.md', 'f1.md', 'f2.md', 'f3.md', 'f4.md', 'f5.md']);
  });

  it('stops at the folder itself outside a repository', async () => {
    const loose = await mkdtemp(join(tmpdir(), 'geniro-loose-'));
    try {
      await writeFile(join(loose, 'CLAUDE.md'), 'loose');
      const measured = await measureRepoInstructionFiles(CLAUDE_LIKE, loose);
      expect(measured).toMatchObject({
        kind: 'measured',
        root: loose,
        chars: 5,
      });
    } finally {
      await rm(loose, { recursive: true, force: true });
    }
  });

  it('says why when the CLI declares no files, or the folder is gone', async () => {
    await expect(
      measureRepoInstructionFiles(
        { kind: 'unavailable', reason: 'picked per request' },
        repo,
      ),
    ).resolves.toEqual({ kind: 'unavailable', reason: 'picked per request' });
    await expect(
      measureRepoInstructionFiles(CLAUDE_LIKE, join(repo, 'gone')),
    ).resolves.toEqual({
      kind: 'unavailable',
      reason: 'the folder the session started in is no longer on disk',
    });
  });

  it('answers an empty measure, never a missing one, for a repository with no files', async () => {
    await expect(
      measureRepoInstructionFiles(CLAUDE_LIKE, repo),
    ).resolves.toEqual({
      kind: 'measured',
      root: repo,
      files: [],
      chars: 0,
      approxTokens: 0,
    });
  });
});

describe('importsOf', () => {
  it('resolves relative, home and absolute imports and skips code', () => {
    expect(
      importsOf(
        '@a.md, @./b.md @~/c.md @/abs/d.md\n```\n@fenced.md\n```\n`@span.md`',
        '/repo/docs',
        '/home/u',
      ),
    ).toEqual([
      '/repo/docs/a.md',
      '/repo/docs/b.md',
      '/home/u/c.md',
      '/abs/d.md',
    ]);
  });
});

describe('namesPaths', () => {
  it('reads paths only from the frontmatter', () => {
    expect(namesPaths('---\npaths:\n  - a/**\n---\nbody')).toBe(true);
    expect(namesPaths('---\ndescription: d\n---\npaths: in the body')).toBe(
      false,
    );
    expect(namesPaths('no frontmatter')).toBe(false);
  });
});
