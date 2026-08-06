import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ChildJournal,
  type ChildJournalFile,
  clearChildJournal,
  configureChildJournal,
  currentChildJournal,
  readChildJournal,
  resetChildJournal,
  trackDetachedChild,
} from './child-journal';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'geniro-journal-'));
  path = join(dir, 'children.json');
});

afterEach(() => {
  resetChildJournal();
  rmSync(dir, { recursive: true, force: true });
});

/** A stand-in for the slice of ChildProcess the journal touches. */
function fakeChild(pid: number | undefined): EventEmitter & { pid?: number } {
  return Object.assign(new EventEmitter(), { pid });
}

function readRaw(): ChildJournalFile {
  return JSON.parse(readFileSync(path, 'utf8')) as ChildJournalFile;
}

describe('ChildJournal', () => {
  it('writes a spawned group to disk immediately, stamped with this daemon', () => {
    // The whole contract: the record must be durable BEFORE the caller
    // continues, because the SIGKILL it guards against can land on the next tick.
    new ChildJournal(path, undefined, () => 1_700).record(4242, '/bin/claude');

    expect(readRaw()).toEqual({
      version: 1,
      ownerPid: process.pid,
      children: [{ pid: 4242, startedAt: 1_700, command: '/bin/claude' }],
    });
  });

  it('drops a group that exited', () => {
    const journal = new ChildJournal(path);
    journal.record(1, 'a');
    journal.record(2, 'b');

    journal.forget(1);

    expect(readRaw().children.map((c) => c.pid)).toEqual([2]);
  });

  it('reports an unwritable journal instead of failing the spawn', () => {
    const warn = vi.fn();
    // A directory where the file should be: the rename cannot succeed.
    const journal = new ChildJournal(dir, { warn });

    expect(() => journal.record(7, '/bin/claude')).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('will not be reaped');
  });
});

describe('readChildJournal', () => {
  it('round-trips what a previous launch wrote', () => {
    new ChildJournal(path, undefined, () => 55).record(99, '/bin/cursor-agent');

    expect(readChildJournal(path)).toEqual({
      version: 1,
      ownerPid: process.pid,
      children: [{ pid: 99, startedAt: 55, command: '/bin/cursor-agent' }],
    });
  });

  it('is silent about a missing file — a clean previous shutdown', () => {
    const warn = vi.fn();

    expect(readChildJournal(join(dir, 'absent.json'), { warn })).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('refuses unparseable JSON, and says so', () => {
    const warn = vi.fn();
    writeFileSync(path, '{not json');

    expect(readChildJournal(path, { warn })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('refuses a well-formed file of the wrong shape', () => {
    const warn = vi.fn();
    // A future version, or a hand-edited file. Reaping from a shape we do not
    // understand would mean SIGKILLing numbers we cannot vouch for.
    writeFileSync(
      path,
      JSON.stringify({ version: 99, ownerPid: 1, children: [] }),
    );

    expect(readChildJournal(path, { warn })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('refuses a file whose entries are not journaled children', () => {
    writeFileSync(
      path,
      JSON.stringify({ version: 1, ownerPid: 1, children: [{ pid: 'x' }] }),
    );

    expect(readChildJournal(path)).toBeNull();
  });
});

describe('clearChildJournal', () => {
  it('removes the file, and tolerates one that is already gone', () => {
    new ChildJournal(path).record(1, 'a');

    clearChildJournal(path);
    expect(() => clearChildJournal(path)).not.toThrow();

    expect(readChildJournal(path)).toBeNull();
  });
});

describe('trackDetachedChild', () => {
  it('records nothing until a journal is configured', () => {
    // Pins the default-off state: a unit test that spawns a real child must
    // never write into a developer's userData dir.
    expect(currentChildJournal()).toBeNull();

    trackDetachedChild(fakeChild(123), '/bin/claude');

    expect(readChildJournal(path)).toBeNull();
  });

  it('records a spawned child, then erases it when the child exits', () => {
    configureChildJournal(path);
    const child = fakeChild(321);

    trackDetachedChild(child, '/bin/cursor-agent');
    expect(readChildJournal(path)?.children.map((c) => c.pid)).toEqual([321]);

    child.emit('exit');

    expect(readChildJournal(path)?.children).toEqual([]);
  });

  it('ignores a child that never got a pid', () => {
    configureChildJournal(path);

    trackDetachedChild(fakeChild(undefined), '/bin/claude');

    expect(readChildJournal(path)).toBeNull();
  });
});
