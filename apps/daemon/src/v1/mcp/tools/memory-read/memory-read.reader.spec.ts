import { describe, expect, it } from 'vitest';

import {
  MEMORY_RESULT_PREFACE,
  type MemoryEntry,
} from '../../../memory/memory.types';
import { memoryReadResultText, readMemoryReadArgs } from './memory-read.reader';

const ENTRY: MemoryEntry = {
  id: 'id-2',
  handle: 'm2',
  title: 'Port',
  body: 'The daemon prefers 47615.',
  type: 'reference',
  projectId: null,
  teamSlug: null,
  status: 'active',
  rev: 3,
  source: {
    actor: 'agent',
    agentKind: 'claude',
    model: 'opus',
    runId: 'r1',
    importedFrom: null,
  },
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-02T00:00:00.000Z',
  lastUsedAt: null,
  approvedAt: null,
  indexed: false,
  promotedAt: null,
  forgetReason: null,
  purgeAt: null,
};

describe('readMemoryReadArgs', () => {
  it('reads up to the cap of handles, names the rest unread, and refuses what is not a handle', () => {
    expect(readMemoryReadArgs({ ids: ['m2', '7'] })).toEqual({
      ok: true,
      query: { ids: ['m2', '7'], unread: [] },
    });
    expect(readMemoryReadArgs({ ids: ['m1', 'm2', 'm3', 'm4'] })).toEqual({
      ok: true,
      query: { ids: ['m1', 'm2', 'm3'], unread: ['m4'] },
    });
    expect(readMemoryReadArgs({ ids: ['note'] }).ok).toBe(false);
  });

  it('reads a single id as a one-handle ids', () => {
    expect(readMemoryReadArgs({ id: ' m12 ' })).toEqual({
      ok: true,
      query: { ids: ['m12'], unread: [] },
    });
    expect(readMemoryReadArgs({ id: 'm12' })).toEqual(
      readMemoryReadArgs({ ids: ['m12'] }),
    );
    expect(readMemoryReadArgs({ id: 'm12', ids: null })).toEqual({
      ok: true,
      query: { ids: ['m12'], unread: [] },
    });
  });

  it('reads a handle sent as handle, and handles sent as handles, the first three of more', () => {
    expect(readMemoryReadArgs({ handle: 'm974' })).toEqual({
      ok: true,
      query: { ids: ['m974'], unread: [] },
    });
    expect(
      readMemoryReadArgs({ handles: ['m1', 'm2', 'm3', 'm4', 'm5'] }),
    ).toEqual({
      ok: true,
      query: { ids: ['m1', 'm2', 'm3'], unread: ['m4', 'm5'] },
    });
  });

  it('refuses id and ids sent together, saying to send one of them', () => {
    expect(readMemoryReadArgs({ id: 'm12', ids: ['m12'] })).toEqual({
      ok: false,
      error:
        'call memory_read({ids: ["m12"]}) — at most 3 handles.\nsend ids (a list of handles) or id (one handle), not both',
    });
  });

  it('refuses an id that is not a handle for what it is, not as an unknown field', () => {
    const read = readMemoryReadArgs({ id: 'note' });

    expect(read.ok).toBe(false);
    expect(!read.ok && read.error).toContain('a handle like m12');
    expect(!read.ok && read.error).not.toContain('Unrecognized key');
  });

  it('asks for ids when neither field is sent', () => {
    expect(readMemoryReadArgs({})).toEqual({
      ok: false,
      error:
        'call memory_read({ids: ["m12"]}) — at most 3 handles.\nids is required — the handles to read, like ["m12"]',
    });
  });

  it('leads each refused call with the right call and the cap, whatever was wrong with it', () => {
    const lead = 'call memory_read({ids: ["m12"]}) — at most 3 handles.';
    const cases: Record<string, unknown>[] = [
      { handle: 'note' },
      { items: ['m1'] },
      { ids: ['m1'], handles: ['m2'] },
      {},
    ];
    for (const args of cases) {
      const read = readMemoryReadArgs(args);

      expect(read.ok).toBe(false);
      expect(!read.ok && read.error.split('\n')[0]).toBe(lead);
    }
  });
});

describe('memoryReadResultText', () => {
  it('names the handles it did not read, and the call that reads them', () => {
    expect(
      memoryReadResultText([], [], 'memory-entry-f00d', ['m4', 'm5']),
    ).toBe(
      'Not read — at most 3 per call: m4, m5. Read them with memory_read({ids: ["m4", "m5"]}).',
    );
  });

  it('quotes each entry whole, its body fenced, with its revision and author, then names what it could not read', () => {
    expect(memoryReadResultText([ENTRY], ['m9'], 'memory-entry-f00d')).toBe(
      [
        MEMORY_RESULT_PREFACE,
        'm2 (rev 3, global, reference) — Port\nby claude (opus), updated 2026-10-02T00:00:00.000Z\n<memory-entry-f00d>\nThe daemon prefers 47615.\n</memory-entry-f00d>',
        "Not found: m9 — forgotten, waiting for the user's review, or another project's or team's.",
      ].join('\n\n'),
    );
  });
});
