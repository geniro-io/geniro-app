import { describe, expect, it } from 'vitest';

import {
  anchorComment,
  type DiffHunk,
  pairedWordSpans,
  parseFileDiff,
} from './review-diff-model';

const MODIFIED = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,4 +1,4 @@ function one() {',
  ' const x = 1;',
  '-const y = 2;',
  '+const y = 3;',
  ' const z = 4;',
  ' export {};',
  '@@ -20,3 +20,4 @@ function two() {',
  ' keep();',
  '-old();',
  '+fresh();',
  '+extra();',
  ' done();',
].join('\n');

function hunksOf(diff: string): DiffHunk[] {
  return parseFileDiff(diff).hunks;
}

describe('parseFileDiff', () => {
  it('numbers the rows of each hunk from its header, on the side each row exists', () => {
    const [first, second] = hunksOf(MODIFIED);
    expect(first).toMatchObject({
      oldStart: 1,
      oldLines: 4,
      newStart: 1,
      newLines: 4,
    });
    expect(first!.rows).toEqual([
      { kind: 'context', oldLine: 1, newLine: 1, text: 'const x = 1;' },
      { kind: 'removed', oldLine: 2, newLine: null, text: 'const y = 2;' },
      { kind: 'added', oldLine: null, newLine: 2, text: 'const y = 3;' },
      { kind: 'context', oldLine: 3, newLine: 3, text: 'const z = 4;' },
      { kind: 'context', oldLine: 4, newLine: 4, text: 'export {};' },
    ]);
    expect(second).toMatchObject({
      oldStart: 20,
      oldLines: 3,
      newStart: 20,
      newLines: 4,
    });
    expect(second!.rows).toEqual([
      { kind: 'context', oldLine: 20, newLine: 20, text: 'keep();' },
      { kind: 'removed', oldLine: 21, newLine: null, text: 'old();' },
      { kind: 'added', oldLine: null, newLine: 21, text: 'fresh();' },
      { kind: 'added', oldLine: null, newLine: 22, text: 'extra();' },
      { kind: 'context', oldLine: 22, newLine: 23, text: 'done();' },
    ]);
  });

  it('reads the text after the second @@ as the hunk context', () => {
    const [first, second] = hunksOf(MODIFIED);
    expect(first!.context).toBe('function one() {');
    expect(second!.context).toBe('function two() {');
  });

  it('treats a row whose text begins ++ or -- as content, not as a header', () => {
    const diff = ['@@ -1 +1 @@', '--- a rule', '+++ b rule'].join('\n');
    const [hunk] = hunksOf(diff);
    expect(hunk!.rows).toEqual([
      { kind: 'removed', oldLine: 1, newLine: null, text: '-- a rule' },
      { kind: 'added', oldLine: null, newLine: 1, text: '++ b rule' },
    ]);
  });

  it('keeps a no-newline marker as a note row with no line numbers', () => {
    const diff = [
      '@@ -1 +1 @@',
      '-a',
      '\\ No newline at end of file',
      '+b',
      '\\ No newline at end of file',
    ].join('\n');
    const [hunk] = hunksOf(diff);
    expect(hunk!.rows).toEqual([
      { kind: 'removed', oldLine: 1, newLine: null, text: 'a' },
      {
        kind: 'note',
        oldLine: null,
        newLine: null,
        text: '\\ No newline at end of file',
      },
      { kind: 'added', oldLine: null, newLine: 1, text: 'b' },
      {
        kind: 'note',
        oldLine: null,
        newLine: null,
        text: '\\ No newline at end of file',
      },
    ]);
  });

  it('reads a binary file as binary with no hunks', () => {
    const diff = [
      'diff --git a/logo.png b/logo.png',
      'index 1111111..2222222 100644',
      'Binary files a/logo.png and b/logo.png differ',
    ].join('\n');
    expect(parseFileDiff(diff)).toEqual({
      hunks: [],
      notes: [],
      binary: true,
      truncatedLines: null,
    });
  });

  it('reads a git binary patch as binary with no hunks', () => {
    const diff = [
      'diff --git a/x.bin b/x.bin',
      'index 1111111..2222222',
      'GIT binary patch',
      'literal 3',
      'KcmZQzU|?i0',
    ].join('\n');
    const parsed = parseFileDiff(diff);
    expect(parsed.binary).toBe(true);
    expect(parsed.hunks).toEqual([]);
  });

  it('takes the truncation notice out of the rows and reports how many lines were cut', () => {
    const diff = [
      'diff --git a/big.ts b/big.ts',
      'index 1111111..2222222 100644',
      '--- a/big.ts',
      '+++ b/big.ts',
      '@@ -1,3 +1,3 @@',
      ' a',
      '-b',
      '+c',
      ' d',
      '',
      '… 37 more lines — open the file to read the rest.',
    ].join('\n');
    const parsed = parseFileDiff(diff);
    expect(parsed.truncatedLines).toBe(37);
    expect(parsed.hunks[0]!.rows.map((row) => row.text)).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
  });

  it('reads a rename as a note naming the old path, and a mode change as a note with both modes', () => {
    const rename = [
      'diff --git a/src/old.ts b/src/new.ts',
      'similarity index 90%',
      'rename from src/old.ts',
      'rename to src/new.ts',
      'index 1111111..2222222 100644',
      '--- a/src/old.ts',
      '+++ b/src/new.ts',
      '@@ -1 +1 @@',
      '-a',
      '+b',
    ].join('\n');
    const renamed = parseFileDiff(rename);
    expect(renamed.notes).toEqual(['Renamed from src/old.ts']);
    expect(renamed.hunks).toHaveLength(1);

    const mode = [
      'diff --git a/run.sh b/run.sh',
      'old mode 100644',
      'new mode 100755',
    ].join('\n');
    expect(parseFileDiff(mode)).toEqual({
      hunks: [],
      notes: ['Mode changed 100644 → 100755'],
      binary: false,
      truncatedLines: null,
    });
  });

  it('reads no diff as nothing', () => {
    expect(parseFileDiff(null)).toEqual({
      hunks: [],
      notes: [],
      binary: false,
      truncatedLines: null,
    });
  });
});

describe('pairedWordSpans', () => {
  it('marks the words that differ in each paired removed and added row', () => {
    const diff = [
      '@@ -1,3 +1,3 @@',
      ' import x;',
      '-const value = first + 1;',
      '+const value = second + 1;',
      ' done();',
    ].join('\n');
    const [hunk] = hunksOf(diff);
    const spans = pairedWordSpans(hunk!);
    const removedText = hunk!.rows[1]!.text;
    const addedText = hunk!.rows[2]!.text;
    expect(spans.has(0)).toBe(false);
    expect(spans.has(3)).toBe(false);
    const [removed] = spans.get(1)!;
    const [added] = spans.get(2)!;
    expect(removedText.slice(removed!.start, removed!.end)).toBe('first');
    expect(addedText.slice(added!.start, added!.end)).toBe('second');
  });
});

describe('anchorComment', () => {
  const NEW_SIDE = [
    '@@ -1,3 +1,5 @@',
    ' function run() {',
    '-  return first();',
    '+  const pad = 1;',
    '+  const more = 2;',
    '+  return second();   ',
    ' }',
  ].join('\n');
  const hunks = hunksOf(NEW_SIDE);

  it('anchors a quote that still sits at its stored line', () => {
    expect(
      anchorComment(
        { side: 'new', startLine: 3, endLine: 3, quote: '  const more = 2;' },
        hunks,
      ),
    ).toEqual({ kind: 'line', side: 'new', startLine: 3, endLine: 3 });
  });

  it('follows a quote whose lines moved, to where they are now', () => {
    expect(
      anchorComment(
        { side: 'new', startLine: 2, endLine: 2, quote: '  const more = 2;' },
        hunks,
      ),
    ).toEqual({ kind: 'line', side: 'new', startLine: 3, endLine: 3 });
  });

  it('ignores trailing whitespace on either side of the match', () => {
    expect(
      anchorComment(
        { side: 'new', startLine: 4, endLine: 4, quote: '  return second();' },
        hunks,
      ),
    ).toEqual({ kind: 'line', side: 'new', startLine: 4, endLine: 4 });
    expect(
      anchorComment(
        {
          side: 'new',
          startLine: 2,
          endLine: 3,
          quote: '  const pad = 1;  \n  const more = 2;',
        },
        hunks,
      ),
    ).toEqual({ kind: 'line', side: 'new', startLine: 2, endLine: 3 });
  });

  it('is outdated when the quoted lines no longer appear on its side', () => {
    expect(
      anchorComment(
        { side: 'new', startLine: 4, endLine: 4, quote: '  return third();' },
        hunks,
      ),
    ).toEqual({ kind: 'outdated' });
  });

  it('anchors an old-side comment on the old line numbers', () => {
    expect(
      anchorComment(
        { side: 'old', startLine: 2, endLine: 2, quote: '  return first();' },
        hunks,
      ),
    ).toEqual({ kind: 'line', side: 'old', startLine: 2, endLine: 2 });
  });

  it('is always a file anchor for a whole-file comment', () => {
    expect(
      anchorComment(
        { side: 'file', startLine: null, endLine: null, quote: '' },
        hunks,
      ),
    ).toEqual({ kind: 'file' });
  });

  it('anchors a repeated quote at the match nearest the line it was written on', () => {
    const repeated = hunksOf(
      [
        '@@ -0,0 +1,5 @@',
        '+x',
        '+  return value;',
        '+y',
        '+z',
        '+  return value;',
      ].join('\n'),
    );
    expect(
      anchorComment(
        { side: 'new', startLine: 4, endLine: 4, quote: '  return value;' },
        repeated,
      ),
    ).toEqual({ kind: 'line', side: 'new', startLine: 5, endLine: 5 });
    expect(
      anchorComment(
        { side: 'new', startLine: 1, endLine: 1, quote: '  return value;' },
        repeated,
      ),
    ).toEqual({ kind: 'line', side: 'new', startLine: 2, endLine: 2 });
  });
});
