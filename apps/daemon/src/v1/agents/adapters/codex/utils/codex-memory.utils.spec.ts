import {
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
  codexMemoryHandbookPath,
  parseCodexMemoryHandbook,
  readCodexMemoryNotes,
} from './codex-memory.utils';

const HANDBOOK = `# Memory handbook

# Task Group: geniro-app daemon work
scope: repository
applies_to: cwd=/repo/app

## Task 1: fix the pidfile race, done
### keywords
pidfile, lock

# Task Group: Release checklist
## Task 1: cut 1.4
Tag, then publish.

# Task Group: Empty group
`;

describe('parseCodexMemoryHandbook', () => {
  it('makes one note per task group, its subsections kept inside it', () => {
    const notes = parseCodexMemoryHandbook(HANDBOOK, '/h/MEMORY.md');

    expect(notes.map((note) => note.title)).toEqual([
      'geniro-app daemon work',
      'Release checklist',
    ]);
    expect(notes[0]!.body).toBe(
      'scope: repository\napplies_to: cwd=/repo/app\n\n## Task 1: fix the pidfile race, done\n### keywords\npidfile, lock',
    );
    expect(notes[1]).toEqual({
      path: '/h/MEMORY.md',
      importedFrom: '/h/MEMORY.md · Release checklist',
      projectKey: null,
      title: 'Release checklist',
      body: '## Task 1: cut 1.4\nTag, then publish.',
      type: null,
    });
  });
});

describe('readCodexMemoryNotes', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'geniro-codex-memory-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('finds nothing in an empty or missing memories directory', async () => {
    expect(await readCodexMemoryNotes(home)).toEqual([]);
    mkdirSync(join(home, 'memories'));
    expect(await readCodexMemoryNotes(home)).toEqual([]);
  });

  it('reads the handbook at memories/MEMORY.md', async () => {
    mkdirSync(join(home, 'memories'));
    writeFileSync(codexMemoryHandbookPath(home), HANDBOOK);

    expect(
      (await readCodexMemoryNotes(home)).map((note) => note.title),
    ).toEqual(['geniro-app daemon work', 'Release checklist']);
  });

  it('follows no symlinked memories directory', async () => {
    const elsewhere = join(home, 'elsewhere');
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, 'MEMORY.md'), HANDBOOK);
    symlinkSync(elsewhere, join(home, 'memories'));

    expect(await readCodexMemoryNotes(home)).toEqual([]);
  });

  it('follows no symlinked handbook', async () => {
    const elsewhere = join(home, 'elsewhere.md');
    writeFileSync(elsewhere, HANDBOOK);
    mkdirSync(join(home, 'memories'));
    symlinkSync(elsewhere, codexMemoryHandbookPath(home));

    expect(await readCodexMemoryNotes(home)).toEqual([]);
  });
});
