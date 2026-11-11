import { afterEach, describe, expect, it } from 'vitest';

import { clearSecrets, registerSecret } from '../../diagnostics/utils/redact';
import {
  CHECK_QUOTE_MAX_CHARS,
  CHECK_REASON_MAX_CHARS,
  checkedText,
  checkPrompt,
  quoteIn,
  readCheckAnswer,
} from './memory-check-prompt';
import { MEMORY_NOTES_FRAMING } from './memory-triage';

const pairs = [
  {
    a: { title: 'Pnpm workspace', body: 'Run pnpm install.' },
    b: { title: 'Install', body: 'Use npm install.' },
  },
  {
    a: { title: 'Loopback', body: 'Bind 127.0.0.1.' },
    b: { title: 'Port', body: 'Listen on 0.0.0.0.' },
  },
];

describe('checkPrompt', () => {
  afterEach(() => clearSecrets());

  it('opens with the framing, numbers each pair and labels its two notes', () => {
    const prompt = checkPrompt(pairs);

    expect(prompt.startsWith(MEMORY_NOTES_FRAMING.join('\n'))).toBe(true);
    expect(prompt).toContain(
      '[p1]\nA: Pnpm workspace\nRun pnpm install.\nB: Install\nUse npm install.',
    );
    expect(prompt).toContain(
      '[p2]\nA: Loopback\nBind 127.0.0.1.\nB: Port\nListen on 0.0.0.0.',
    );
  });

  it('masks a registered secret in either note before it leaves', () => {
    registerSecret('sk-live-123456789', 'test');

    const prompt = checkPrompt([
      {
        a: { title: 'Key', body: 'The key is sk-live-123456789.' },
        b: { title: 'Key again', body: 'sk-live-123456789 still works.' },
      },
    ]);

    expect(prompt).not.toContain('sk-live-123456789');
    expect(prompt).toContain('A: Key\n');
  });
});

describe('checkedText', () => {
  afterEach(() => clearSecrets());

  it('one-lines the title and keeps the body whole, which is what quotes are checked against', () => {
    expect(checkedText({ title: 'a  note', body: 'first\nsecond\n' })).toBe(
      'a note\nfirst\nsecond',
    );
  });
});

describe('readCheckAnswer', () => {
  it('reads a fenced array, mapping ids back to pair positions', () => {
    const verdicts = readCheckAnswer(
      '```json\n[{"id":"p2","verdict":"contradicts","quoteA":"Bind 127.0.0.1","quoteB":"Listen on 0.0.0.0","reason":"opposed"},{"id":"p1","verdict":"unrelated"}]\n```',
      2,
    );

    expect(verdicts).toEqual(
      new Map([
        [
          1,
          {
            verdict: 'contradicts',
            quoteA: 'Bind 127.0.0.1',
            quoteB: 'Listen on 0.0.0.0',
            reason: 'opposed',
          },
        ],
        [0, { verdict: 'unrelated', quoteA: '', quoteB: '', reason: '' }],
      ]),
    );
  });

  it('drops entries naming no pair, a pair twice, an unknown verdict or no object, and clips a long reason', () => {
    const verdicts = readCheckAnswer(
      JSON.stringify([
        { id: 'p9', verdict: 'duplicate' },
        { id: 'p1', verdict: 'maybe' },
        'p2',
        {
          id: 'p2',
          verdict: 'duplicate',
          reason: 'r'.repeat(CHECK_REASON_MAX_CHARS * 2),
        },
        { id: 'p2', verdict: 'unrelated' },
      ]),
      2,
    );

    expect([...verdicts!.keys()]).toEqual([1]);
    expect(verdicts!.get(1)!.verdict).toBe('duplicate');
    expect(verdicts!.get(1)!.reason).toHaveLength(CHECK_REASON_MAX_CHARS);
    expect(verdicts!.get(1)!.reason.endsWith('…')).toBe(true);
  });

  it('answers null for prose, broken JSON or an object that is not an array', () => {
    expect(readCheckAnswer('they are all unrelated', 1)).toBeNull();
    expect(readCheckAnswer('[{"id":"p1",', 1)).toBeNull();
    expect(readCheckAnswer('{"id":"p1","verdict":"duplicate"}', 1)).toBeNull();
  });

  it('reads an empty array as no verdicts, not as a failed answer', () => {
    expect(readCheckAnswer('[] and [', 1)).toEqual(new Map());
  });
});

describe('quoteIn', () => {
  it('finds a quote word for word, a line break in the text counting as one space', () => {
    expect(
      quoteIn(
        'Always run pnpm install',
        'Pnpm workspace\nAlways run pnpm\ninstall in the root.',
      ),
    ).toBe(true);
  });

  it('refuses a quote that is too short, too long or not in the text', () => {
    expect(quoteIn('pnpm', 'Use pnpm install.')).toBe(false);
    expect(
      quoteIn(
        'x'.repeat(CHECK_QUOTE_MAX_CHARS + 1),
        'x'.repeat(CHECK_QUOTE_MAX_CHARS + 1),
      ),
    ).toBe(false);
    expect(quoteIn('Delete the lockfile entirely', 'Use pnpm install.')).toBe(
      false,
    );
  });
});
