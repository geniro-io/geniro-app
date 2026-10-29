import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  parseClaudeMemoryNote,
  readClaudeMemoryNotes,
} from './claude-memory.utils';

describe('readClaudeMemoryNotes', () => {
  let profile: string;

  beforeEach(() => {
    profile = mkdtempSync(join(tmpdir(), 'geniro-claude-memory-'));
  });

  afterEach(() => {
    rmSync(profile, { recursive: true, force: true });
  });

  function note(project: string, file: string, text: string): string {
    const dir = join(profile, 'projects', project, 'memory');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, file), text);
    return join(dir, file);
  }

  it('reads each project’s fact files and skips its MEMORY.md index', async () => {
    const fact = note(
      '-repo-app',
      'use-pnpm.md',
      '---\nname: use-pnpm\ndescription: Installs go through pnpm.\ntype: feedback\n---\n\nNever npm here.\n',
    );
    note(
      '-repo-app',
      'MEMORY.md',
      '# Memory Index\n- [Use pnpm](use-pnpm.md)\n',
    );
    note('-repo-app', 'notes.txt', 'not a note');
    writeFileSync(
      join(profile, 'projects', '-repo-app', 'session.jsonl'),
      `${JSON.stringify({ type: 'user', cwd: '/repo/app' })}\n`,
    );

    const notes = await readClaudeMemoryNotes(profile);

    expect(notes).toEqual([
      {
        path: fact,
        importedFrom: fact,
        projectKey: '-repo-app',
        folder: '/repo/app',
        title: 'use-pnpm',
        body: 'Installs go through pnpm.\n\nNever npm here.',
        type: 'feedback',
      },
    ]);
  });

  it('follows no symlinked projects directory, and reads no hard-linked note', async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'geniro-claude-elsewhere-'));
    try {
      mkdirSync(join(elsewhere, '-repo', 'memory'), { recursive: true });
      writeFileSync(join(elsewhere, '-repo', 'memory', 'n.md'), 'x');
      symlinkSync(elsewhere, join(profile, 'projects'));
      expect(await readClaudeMemoryNotes(profile)).toEqual([]);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
    const other = mkdtempSync(join(tmpdir(), 'geniro-claude-linked-'));
    try {
      rmSync(join(profile, 'projects'));
      const dir = join(other, 'projects', '-repo', 'memory');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(other, 'outside.md'), '---\nname: outside\n---\nx');
      linkSync(join(other, 'outside.md'), join(dir, 'linked.md'));
      expect(await readClaudeMemoryNotes(other)).toEqual([]);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('follows no symlinked memory directory', async () => {
    const elsewhere = join(profile, 'elsewhere');
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, 'n.md'), '---\nname: outside\n---\nx');
    mkdirSync(join(profile, 'projects', '-repo'), { recursive: true });
    symlinkSync(elsewhere, join(profile, 'projects', '-repo', 'memory'));

    expect(await readClaudeMemoryNotes(profile)).toEqual([]);
  });

  it('follows no symlink, and reads nothing from a profile with no projects', async () => {
    const outside = join(profile, 'outside.md');
    writeFileSync(outside, '---\nname: secret\n---\nnot a note');
    const dir = join(profile, 'projects', '-repo', 'memory');
    mkdirSync(dir, { recursive: true });
    symlinkSync(outside, join(dir, 'linked.md'));
    const empty = mkdtempSync(join(tmpdir(), 'geniro-claude-empty-'));

    try {
      expect(await readClaudeMemoryNotes(profile)).toEqual([]);
      expect(await readClaudeMemoryNotes(empty)).toEqual([]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('parseClaudeMemoryNote', () => {
  it('takes the type from metadata when the top level has none', () => {
    const note = parseClaudeMemoryNote(
      '---\nname: x\ndescription: d\nmetadata:\n  node_type: memory\n  type: project\n---\nbody',
      '/p/x.md',
    );

    expect(note.type).toBe('project');
  });

  it('titles a file without frontmatter by its name and keeps its whole text', () => {
    expect(parseClaudeMemoryNote('just text\n', '/p/loose-note.md')).toEqual({
      title: 'loose-note',
      body: 'just text',
      type: null,
    });
  });
});
