import { describe, expect, it } from 'vitest';

import {
  HOST_COMPARISON_TOOL,
  MAX_COMPARISON_CRITERIA,
  MAX_COMPARISON_OPTIONS,
  MAX_COMPARISON_REASON_LENGTH,
} from '../chat.types';
import {
  hostComparisonResultText,
  isHostComparisonCall,
  readHostComparison,
} from './host-comparison';

const SERVER = 'geniro-1a2b3c4d';

const OPTIONS = [{ name: 'SQLite' }, { name: 'Postgres' }];

describe('isHostComparisonCall', () => {
  it('matches both CLIs’ spellings of this run’s server', () => {
    expect(
      isHostComparisonCall(SERVER, `mcp__${SERVER}__${HOST_COMPARISON_TOOL}`),
    ).toBe(true);
    expect(
      isHostComparisonCall(SERVER, `${SERVER}: ${HOST_COMPARISON_TOOL}`),
    ).toBe(true);
  });

  it('refuses somebody else’s tool of the same name', () => {
    expect(isHostComparisonCall(SERVER, 'mcp__acme__show_comparison')).toBe(
      false,
    );
    expect(
      isHostComparisonCall(null, `mcp__${SERVER}__${HOST_COMPARISON_TOOL}`),
    ).toBe(false);
  });
});

describe('readHostComparison', () => {
  it('reads a comparison', () => {
    expect(
      readHostComparison({
        title: 'Local store for the daemon',
        options: [
          { name: 'SQLite', note: 'embedded, one file' },
          { name: 'Postgres' },
        ],
        criteria: [
          {
            label: 'Setup cost',
            cells: [
              { value: 'none — a file', verdict: 'good' },
              { value: 'a server to run', verdict: 'bad' },
            ],
          },
          {
            label: 'Concurrency',
            cells: [
              { value: 'one writer', verdict: 'bad' },
              { value: 'many', verdict: 'good' },
            ],
          },
        ],
        recommendation: {
          option: 'SQLite',
          reason: 'the daemon is single-writer and local-first by rule',
        },
      }),
    ).toEqual({
      title: 'Local store for the daemon',
      options: [
        { name: 'SQLite', note: 'embedded, one file' },
        { name: 'Postgres' },
      ],
      criteria: [
        {
          label: 'Setup cost',
          cells: [
            { value: 'none — a file', verdict: 'good' },
            { value: 'a server to run', verdict: 'bad' },
          ],
        },
        {
          label: 'Concurrency',
          cells: [
            { value: 'one writer', verdict: 'bad' },
            { value: 'many', verdict: 'good' },
          ],
        },
      ],
      recommendation: {
        option: 'SQLite',
        reason: 'the daemon is single-writer and local-first by rule',
      },
    });
  });

  it('RE-ALIGNS every row to the option count, padding and cutting', () => {
    // The positional rule. A short row would leave the last option looking
    // un-assessed; a long one carries a cell no column can show. This is the
    // same treatment the chart gives a series against its labels.
    const read = readHostComparison({
      title: 'T',
      options: [{ name: 'A' }, { name: 'B' }, { name: 'C' }],
      criteria: [
        { label: 'short', cells: [{ value: 'a' }] },
        {
          label: 'long',
          cells: [
            { value: 'a' },
            { value: 'b' },
            { value: 'c' },
            { value: 'd' },
          ],
        },
      ],
    });
    expect(read?.criteria[0]?.cells).toEqual([
      { value: 'a' },
      { value: '' },
      { value: '' },
    ]);
    expect(read?.criteria[1]?.cells).toEqual([
      { value: 'a' },
      { value: 'b' },
      { value: 'c' },
    ]);
  });

  it('BLANKS an unreadable cell rather than dropping it', () => {
    // Dropping would shift every cell after it one column left, filing each
    // option's answer under its neighbour's name — a failure that does not
    // throw and still looks like a comparison.
    const read = readHostComparison({
      title: 'T',
      options: [{ name: 'A' }, { name: 'B' }, { name: 'C' }],
      criteria: [
        { label: 'row', cells: [{ value: 'a' }, null, { value: 'c' }] },
      ],
    });
    expect(read?.criteria[0]?.cells).toEqual([
      { value: 'a' },
      { value: '' },
      { value: 'c' },
    ]);
  });

  it('reads a bare string cell as a value with no verdict', () => {
    const read = readHostComparison({
      title: 'T',
      options: OPTIONS,
      criteria: [{ label: 'row', cells: ['yes', 'no'] }],
    });
    expect(read?.criteria[0]?.cells).toEqual([
      { value: 'yes' },
      { value: 'no' },
    ]);
  });

  it('drops an unrecognised verdict rather than colouring by it', () => {
    const read = readHostComparison({
      title: 'T',
      options: OPTIONS,
      criteria: [
        {
          label: 'row',
          cells: [
            { value: 'a', verdict: 'gooood' },
            { value: 'b', verdict: 'bad' },
          ],
        },
      ],
    });
    expect(read?.criteria[0]?.cells).toEqual([
      { value: 'a' },
      { value: 'b', verdict: 'bad' },
    ]);
  });

  it('refuses fewer than TWO options', () => {
    // Not a formality: a one-column "comparison" is the shape a model produces
    // when it has decided before it has compared, and drawing it would dress
    // that up as an analysis.
    expect(
      readHostComparison({
        title: 'T',
        options: [{ name: 'only' }],
        criteria: [{ label: 'row', cells: [{ value: 'a' }] }],
      }),
    ).toBeNull();
    // …including when the second option was unreadable rather than absent.
    expect(
      readHostComparison({
        title: 'T',
        options: [{ name: 'only' }, { note: 'no name' }],
        criteria: [{ label: 'row', cells: [{ value: 'a' }] }],
      }),
    ).toBeNull();
  });

  it('refuses every other shape that is not a comparison', () => {
    for (const args of [
      {},
      { title: 'T' },
      { title: 'T', options: OPTIONS },
      { title: 'T', options: OPTIONS, criteria: [] },
      { title: 'T', options: OPTIONS, criteria: [{ cells: [] }] },
      { options: OPTIONS, criteria: [{ label: 'row' }] },
      { title: 'T', options: 'SQLite vs Postgres', criteria: [] },
    ]) {
      expect(readHostComparison(args)).toBeNull();
    }
  });

  it('drops a HALF recommendation rather than half-drawing it', () => {
    // A named option with no reason is an assertion the reader cannot weigh;
    // a reason naming no option is a paragraph.
    const base = {
      title: 'T',
      options: OPTIONS,
      criteria: [{ label: 'row', cells: [{ value: 'a' }, { value: 'b' }] }],
    };
    for (const recommendation of [
      { option: 'SQLite' },
      { reason: 'because' },
      { option: '  ', reason: 'because' },
      'SQLite',
      null,
    ]) {
      expect(
        readHostComparison({ ...base, recommendation })?.recommendation,
      ).toBeUndefined();
    }
  });

  it('keeps a recommendation naming NO option — the reason still reads', () => {
    // Matching is the card's job, and a name that matches nothing costs only
    // the column highlight.
    const read = readHostComparison({
      title: 'T',
      options: OPTIONS,
      criteria: [{ label: 'row', cells: [{ value: 'a' }, { value: 'b' }] }],
      recommendation: { option: 'DuckDB', reason: 'neither, actually' },
    });
    expect(read?.recommendation).toEqual({
      option: 'DuckDB',
      reason: 'neither, actually',
    });
  });

  it('cuts an over-long reason at a WORD boundary, and says so', () => {
    // Observed on a live turn: a recommendation ran past the cap and the card
    // ended "…and where migrati", which does not read as a truncation — it
    // reads as the app corrupting the agent's answer.
    const long = `${'word '.repeat(200)}end`;
    const read = readHostComparison({
      title: 'T',
      options: OPTIONS,
      criteria: [{ label: 'r', cells: [{ value: 'a' }, { value: 'b' }] }],
      recommendation: { option: 'SQLite', reason: long },
    });
    const reason = read?.recommendation?.reason ?? '';
    expect(reason.length).toBeLessThanOrEqual(MAX_COMPARISON_REASON_LENGTH + 1);
    expect(reason.endsWith('…')).toBe(true);
    // The cut landed between words: nothing before the ellipsis is a fragment.
    expect(reason.slice(0, -1).endsWith('word')).toBe(true);
  });

  it('leaves a reason that FITS exactly as written', () => {
    // No ellipsis on prose that was never cut — the mark has to mean something.
    const read = readHostComparison({
      title: 'T',
      options: OPTIONS,
      criteria: [{ label: 'r', cells: [{ value: 'a' }, { value: 'b' }] }],
      recommendation: {
        option: 'SQLite',
        reason: 'single-writer, local-first',
      },
    });
    expect(read?.recommendation?.reason).toBe('single-writer, local-first');
  });

  it('still cuts a single unbroken word, ellipsis included', () => {
    // No boundary to cut at, so slicing is the only option — but the reader
    // must still be told the thing was cut.
    const read = readHostComparison({
      title: 'T',
      options: OPTIONS,
      criteria: [{ label: 'r', cells: [{ value: 'a' }, { value: 'b' }] }],
      recommendation: {
        option: 'SQLite',
        reason: 'x'.repeat(MAX_COMPARISON_REASON_LENGTH + 50),
      },
    });
    const reason = read?.recommendation?.reason ?? '';
    expect(reason).toHaveLength(MAX_COMPARISON_REASON_LENGTH + 1);
    expect(reason.endsWith('x…')).toBe(true);
  });

  it('TRUNCATES the counts rather than refusing', () => {
    const read = readHostComparison({
      title: 'T',
      options: Array.from({ length: MAX_COMPARISON_OPTIONS + 3 }, (_, i) => ({
        name: `o${i}`,
      })),
      criteria: Array.from({ length: MAX_COMPARISON_CRITERIA + 3 }, (_, i) => ({
        label: `c${i}`,
        cells: [],
      })),
    });
    expect(read?.options).toHaveLength(MAX_COMPARISON_OPTIONS);
    expect(read?.criteria).toHaveLength(MAX_COMPARISON_CRITERIA);
    // …and every row is aligned to the TRUNCATED option count, not the sent one.
    expect(read?.criteria[0]?.cells).toHaveLength(MAX_COMPARISON_OPTIONS);
  });
});

describe('hostComparisonResultText', () => {
  it('is a RECEIPT that tells the agent not to write the table out again', () => {
    const text = hostComparisonResultText({
      status: 'drawn',
      options: 3,
      criteria: 5,
    });
    expect(text).toContain('3 options over 5 criteria');
    expect(text).toContain('Do not repeat the table');
  });

  it('tells an unreachable channel to fall back to words', () => {
    expect(
      hostComparisonResultText({ status: 'unavailable', reason: 'no turn' }),
    ).toContain('no turn');
  });
});
