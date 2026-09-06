import { describe, expect, it } from 'vitest';

import { searchableText, searchIndexText } from './searchable-text';

describe('searchableText', () => {
  it("returns a message row's text", () => {
    expect(searchableText({ text: 'the bloom filter is sized wrong' })).toBe(
      'the bloom filter is sized wrong',
    );
  });

  it('reads a system or error row through the `message` key', () => {
    expect(searchableText({ message: 'the CLI exited with code 1' })).toBe(
      'the CLI exited with code 1',
    );
  });

  it.each(['file_path', 'filePath', 'path', 'notebook_path'])(
    "extracts a tool call's target under the `%s` spelling",
    (key) => {
      const text = searchableText({
        name: 'Edit',
        input: { [key]: 'apps/daemon/src/main.ts' },
      });

      expect(text).toContain('apps/daemon/src/main.ts');
    },
  );

  it.each(['command', 'cmd', 'script'])(
    "extracts a tool call's command under the `%s` spelling",
    (key) => {
      const text = searchableText({
        name: 'Bash',
        input: { [key]: 'pnpm full-check' },
      });

      expect(text).toContain('pnpm full-check');
    },
  );

  it('reads a path reported at the top level, not only under `input`', () => {
    // A result row reports its target directly rather than under `input`, so
    // both levels are read — assuming the call's shape would lose every
    // tool_result row's path.
    expect(searchableText({ name: 'Read', path: 'README.md' })).toContain(
      'README.md',
    );
  });

  it("collects a task list's titles, which are that row's only text", () => {
    const text = searchableText({
      mode: 'replace',
      tasks: [
        { title: 'Add the searchText column' },
        { content: 'Write the backfill' },
        { text: 'Regenerate the client' },
      ],
    });

    expect(text).toContain('Add the searchText column');
    expect(text).toContain('Write the backfill');
    expect(text).toContain('Regenerate the client');
  });

  it('collapses newlines and runs of whitespace into single spaces', () => {
    expect(searchableText({ text: 'first\n\n  second\tthird' })).toBe(
      'first second third',
    );
  });

  it('caps the flattened text so a whole-file tool result cannot land in the column', () => {
    const huge = 'x'.repeat(5000);

    expect(searchableText({ result: huge })).toHaveLength(2000);
  });

  it('returns null for a payload that is not a record', () => {
    // Null, not '' — `searchText IS NULL` is the backfill's own predicate for
    // "never flattened", so a row that WAS flattened must never read as null.
    expect(searchableText(null)).toBeNull();
    expect(searchableText('a bare string')).toBeNull();
    expect(searchableText(['an', 'array'])).toBeNull();
  });

  it('returns an empty string — never null — for a record with nothing to match', () => {
    expect(searchableText({ usage: { inputTokens: 12 } })).toBe('');
  });

  it('leaves ids and enum tags out of the index', () => {
    // The allowlist is the point: a generic walk over every string in the
    // payload would make a search for `error` match every row whose stop reason
    // happens to be spelled that way.
    const text = searchableText({
      id: 'toolu_01WidY719zxeAw7Q5FzgaCzB',
      stopReason: 'error',
      origin: 'cli',
    });

    expect(text).toBe('');
  });

  it('keeps the tool name, which is how a user searches for what ran', () => {
    expect(
      searchableText({ id: 'abc', name: 'Bash', input: { command: 'ls' } }),
    ).toBe('Bash ls');
  });
});

describe('searchIndexText', () => {
  it('lowercases ASCII, which SQLite would have folded anyway', () => {
    expect(searchableText({ name: 'Bash' })).toBe('Bash');
    expect(searchIndexText({ name: 'Bash' })).toBe('bash');
  });

  it('lowercases NON-ASCII, which SQLite would NOT have folded', () => {
    // The whole reason this function exists. `LIKE` folds case for ASCII only,
    // so without the fold here a search for `проверка` misses every row where
    // the word was capitalised — and these transcripts are routinely not in
    // English. Drop the `.toLowerCase()` and this is the assertion that goes
    // red while the ASCII one above stays green, which is exactly the shape of
    // the bug it prevents.
    expect(searchIndexText({ text: 'Проверка Bloom-фильтра' })).toBe(
      'проверка bloom-фильтра',
    );
  });

  it('passes a non-record payload through as null', () => {
    // Still the backfill's "never flattened" sentinel — the fold must not turn
    // a null into an empty string.
    expect(searchIndexText(null)).toBeNull();
  });
});
