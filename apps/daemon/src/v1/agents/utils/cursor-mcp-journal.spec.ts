import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  addJournalEntry,
  readJournal,
  removeJournalEntry,
} from './cursor-mcp-journal';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function journalPath(nested = false): string {
  const root = mkdtempSync(join(tmpdir(), 'cursor-journal-spec-'));
  roots.push(root);
  return nested
    ? join(root, 'nested', 'cursor-mcp-journal.json')
    : join(root, 'cursor-mcp-journal.json');
}

describe('cursor-mcp-journal', () => {
  it('round-trips add → read → remove (creating parent dirs); the empty journal file is removed', () => {
    const path = journalPath(true);
    addJournalEntry(path, { cwd: '/a', created: true, ts: 1 });
    addJournalEntry(path, { cwd: '/b', created: false, ts: 2 });
    expect(readJournal(path)).toEqual([
      { cwd: '/a', created: true, ts: 1 },
      { cwd: '/b', created: false, ts: 2 },
    ]);

    removeJournalEntry(path, '/a');
    expect(readJournal(path)).toEqual([{ cwd: '/b', created: false, ts: 2 }]);
    removeJournalEntry(path, '/b');
    expect(existsSync(path)).toBe(false);
    expect(readJournal(path)).toEqual([]);
  });

  it('re-adding a cwd replaces its entry (one live merge per cwd)', () => {
    const path = journalPath();
    addJournalEntry(path, { cwd: '/a', created: true, ts: 1 });
    addJournalEntry(path, { cwd: '/a', created: false, ts: 9 });
    expect(readJournal(path)).toEqual([{ cwd: '/a', created: false, ts: 9 }]);
  });

  it('atomically replaces the journal with owner-only permissions', () => {
    const path = journalPath();
    addJournalEntry(path, { cwd: '/a', created: true, ts: 1 });
    const firstInode = statSync(path).ino;

    addJournalEntry(path, { cwd: '/b', created: false, ts: 2 });

    expect(statSync(path).ino).not.toBe(firstInode);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  it('an unreadable or malformed journal reads as empty, never throws', () => {
    const path = journalPath();
    expect(readJournal(path)).toEqual([]);
    writeFileSync(path, '{not json', 'utf8');
    expect(readJournal(path)).toEqual([]);
    writeFileSync(path, JSON.stringify({ nope: true }), 'utf8');
    expect(readJournal(path)).toEqual([]);
    // A partially-corrupt array is rejected as a whole so a later mutation
    // cannot silently rewrite the journal without the lost entry.
    writeFileSync(
      path,
      JSON.stringify([{ cwd: '/ok', created: true, ts: 1 }, { bad: 1 }]),
      'utf8',
    );
    expect(readJournal(path)).toEqual([]);
  });

  it('refuses to overwrite or delete a malformed recovery journal', () => {
    const path = journalPath();
    writeFileSync(path, '{not json', 'utf8');

    expect(() =>
      addJournalEntry(path, { cwd: '/new', created: true, ts: 1 }),
    ).toThrow('is malformed');
    expect(() => removeJournalEntry(path, '/new')).toThrow('is malformed');
    expect(readFileSync(path, 'utf8')).toBe('{not json');
  });
});
