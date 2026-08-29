import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { contextWindowKey, ContextWindowStore } from './context-window.store';

const AGENT = 'claude';
const MODEL = 'claude-opus-5';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'context-windows-'));
  file = join(dir, 'context-windows.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seed(records: Record<string, unknown>): void {
  writeFileSync(file, JSON.stringify(records), 'utf8');
}

describe('ContextWindowStore — what it remembers', () => {
  it('survives the process that learned it', () => {
    // The whole reason it exists. In memory alone, a run had nothing to scale
    // against until its own first turn COMPLETED, so every chat showed a
    // denominator-less meter for its whole first turn after each app launch.
    const learned = new ContextWindowStore({ file });
    learned.remember(AGENT, MODEL, 1_000_000);

    const nextLaunch = new ContextWindowStore({ file });
    expect(nextLaunch.get(AGENT, MODEL)).toBe(1_000_000);
  });

  it('has the window on disk by the time `remember` returns', () => {
    // The twin of `ModelVocabularyStore`'s pin, and this store had the same
    // floating save: nothing could know when the write landed, so two calls in
    // one tick raced each other's rename and a caller cleaning up behind it had
    // only a delay to wait on.
    const store = new ContextWindowStore({ file });

    store.remember(AGENT, MODEL, 1_000_000);

    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8')) as object).toEqual({
      [contextWindowKey(AGENT, MODEL)]: 1_000_000,
    });
  });

  it('says nothing about a model it has never seen', () => {
    // Unknown must stay unknown: the meter renders a bare count for a null
    // window, where a substituted default would state a denominator nobody
    // reported.
    expect(new ContextWindowStore({ file }).get(AGENT, 'never-run')).toBeNull();
  });

  it('does not share a window between two CLIs naming the same model', () => {
    const store = new ContextWindowStore({ file });
    store.remember('claude', 'shared-name', 1_000_000);

    expect(store.get('cursor-agent', 'shared-name')).toBeNull();
  });
});

describe('ContextWindowStore — what it refuses to remember', () => {
  it.each([
    ['zero', 0],
    ['negative', -1],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('rejects a %s window rather than storing it', (_label, window) => {
    // Consumers read this as "the window" and DIVIDE by it. A zero reaching a
    // consumer puts "Context Infinity% full" in the accessible name.
    const store = new ContextWindowStore({ file });
    store.remember(AGENT, MODEL, window);

    expect(store.get(AGENT, MODEL)).toBeNull();
    expect(() => readFileSync(file, 'utf8')).toThrow();
  });

  it('does not rewrite the file when the value has not changed', () => {
    // A turn completes every few seconds and reports the same window every
    // time; that must not mean a disk write every few seconds.
    const store = new ContextWindowStore({ file });
    store.remember(AGENT, MODEL, 1_000_000);
    rmSync(file);

    store.remember(AGENT, MODEL, 1_000_000);

    // Nothing recreated the file, so nothing was written.
    expect(() => readFileSync(file, 'utf8')).toThrow();
    expect(store.get(AGENT, MODEL)).toBe(1_000_000);
  });

  it('refuses a NEW model past the entry cap, but still updates a known one', () => {
    // The defensive branch `.claude/rules/testing.md` explicitly requires a
    // test for. Evicting to make room would drop a model the user may be on
    // right now, so growth is what is refused.
    const full: Record<string, number> = {};
    for (let i = 0; i < 500; i += 1) {
      full[contextWindowKey(AGENT, `model-${i}`)] = 200_000;
    }
    seed(full);
    const store = new ContextWindowStore({ file });

    store.remember(AGENT, 'one-model-too-many', 1_000_000);
    expect(store.get(AGENT, 'one-model-too-many')).toBeNull();

    // A model already in the file is not new, so correcting it still lands.
    store.remember(AGENT, 'model-7', 1_000_000);
    expect(store.get(AGENT, 'model-7')).toBe(1_000_000);
  });
});

describe('ContextWindowStore — a file it cannot trust', () => {
  it('keeps the good entries and drops the bad ones', () => {
    // Validated per entry rather than per file: one corrupted key must not
    // discard every other model's window.
    seed({
      [contextWindowKey(AGENT, 'good')]: 1_000_000,
      [contextWindowKey(AGENT, 'a-string')]: 'not a number',
      [contextWindowKey(AGENT, 'zero')]: 0,
      [contextWindowKey(AGENT, 'negative')]: -5,
    });
    const store = new ContextWindowStore({ file });

    expect(store.get(AGENT, 'good')).toBe(1_000_000);
    expect(store.get(AGENT, 'a-string')).toBeNull();
    expect(store.get(AGENT, 'zero')).toBeNull();
    expect(store.get(AGENT, 'negative')).toBeNull();
  });

  it('degrades to knowing nothing when the file is malformed', () => {
    writeFileSync(file, '{not json at all', 'utf8');
    expect(new ContextWindowStore({ file }).get(AGENT, MODEL)).toBeNull();
  });

  it('degrades to knowing nothing when the root is not an object', () => {
    writeFileSync(file, '"a string"', 'utf8');
    expect(new ContextWindowStore({ file }).get(AGENT, MODEL)).toBeNull();
  });

  it('refuses to parse an implausibly large file at all', () => {
    // The entry cap bounds the MAP, not the WORK: `readFileSync` + `JSON.parse`
    // materialise the whole file first, and this read happens on the live-delta
    // path — where blocking the event loop mid-turn is the one thing this
    // cache must never cost.
    const huge: Record<string, number> = {};
    for (let i = 0; i < 20_000; i += 1) {
      huge[contextWindowKey(AGENT, `model-${'x'.repeat(40)}-${i}`)] = 200_000;
    }
    seed(huge);
    expect(readFileSync(file, 'utf8').length).toBeGreaterThan(256 * 1024);

    // Including the very first entry, which a size-blind reader would have
    // returned happily.
    const store = new ContextWindowStore({ file });
    expect(store.get(AGENT, `model-${'x'.repeat(40)}-0`)).toBeNull();
  });

  it('counts entries it REJECTS toward the cap, not just the ones it keeps', () => {
    // A file of nothing but invalid pairs would otherwise never reach the cap,
    // so the loop the cap exists to bound would run over every one of them.
    // 600 junk entries, then one good one past the cap: the good one is not
    // reached, which is only observable if rejects are counted.
    const records: Record<string, unknown> = {};
    for (let i = 0; i < 600; i += 1) {
      records[contextWindowKey(AGENT, `junk-${i}`)] = 'not a number';
    }
    records[contextWindowKey(AGENT, 'past-the-cap')] = 1_000_000;
    seed(records);

    expect(new ContextWindowStore({ file }).get(AGENT, 'past-the-cap')).toBe(
      null,
    );
  });

  it('serves the toggle this session even when the write cannot land', () => {
    // A disk failure must not cost the meter its denominator for the rest of
    // the session; the in-memory map is updated before the write is attempted.
    const blocked = join(dir, 'blocker', 'nested.json');
    writeFileSync(join(dir, 'blocker'), 'i am a file, not a directory', 'utf8');
    const store = new ContextWindowStore({ file: blocked });

    store.remember(AGENT, MODEL, 1_000_000);

    expect(store.get(AGENT, MODEL)).toBe(1_000_000);
    expect(() => readFileSync(blocked, 'utf8')).toThrow();
  });
});
