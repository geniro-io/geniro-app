import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

  it('an unreadable or malformed journal reads as empty, never throws', () => {
    const path = journalPath();
    expect(readJournal(path)).toEqual([]);
    writeFileSync(path, '{not json', 'utf8');
    expect(readJournal(path)).toEqual([]);
    writeFileSync(path, JSON.stringify({ nope: true }), 'utf8');
    expect(readJournal(path)).toEqual([]);
    // Entries missing required fields are filtered, valid ones kept.
    writeFileSync(
      path,
      JSON.stringify([{ cwd: '/ok', created: true, ts: 1 }, { bad: 1 }]),
      'utf8',
    );
    expect(readJournal(path)).toEqual([{ cwd: '/ok', created: true, ts: 1 }]);
  });
});
