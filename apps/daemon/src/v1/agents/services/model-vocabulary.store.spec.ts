import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  modelVocabularyKey,
  ModelVocabularyStore,
} from './model-vocabulary.store';

const AGENT = 'cursor-agent';
const MODEL = 'gpt-5.5';
const VERSION = '2026.08.11-e8db854';
const REPLY = '{"jsonrpc":"2.0","result":{"configOptions":[]}}';
const HOUR = 60 * 60_000;
const WEEK = 7 * 24 * HOUR;

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'model-vocabularies-'));
  file = join(dir, 'model-vocabularies.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Wait for the store's fire-and-forget write to reach disk — `remember` is
 * synchronous and the save is a floating promise several ticks long. Polling is
 * what makes this deterministic rather than a race against a fixed delay.
 */
async function waitForFile(): Promise<void> {
  for (let i = 0; i < 200 && !existsSync(file); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Give a write that must NOT happen every chance to happen anyway. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

function seed(records: Record<string, unknown>): void {
  writeFileSync(file, JSON.stringify(records), 'utf8');
}

function record(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { version: VERSION, fetchedAt: 0, value: REPLY, ...over };
}

const isText = (value: unknown): value is string => typeof value === 'string';

describe('ModelVocabularyStore — what it serves', () => {
  it('survives the daemon that took the answer', async () => {
    // The whole reason it exists. In memory alone, every app restart paid the
    // 6.1–8.0s handshake again for a model the user had already opened, which
    // is what "должно быть практически мгновенно" was said about.
    const took = new ModelVocabularyStore({ file, now: () => 1_000 });
    took.remember(AGENT, MODEL, VERSION, REPLY);
    await waitForFile();

    const nextLaunch = new ModelVocabularyStore({ file, now: () => 2_000 });

    expect(nextLaunch.read(AGENT, MODEL, VERSION, isText)?.value).toBe(REPLY);
  });

  it('keeps the CLI-wide answer apart from any one model’s', async () => {
    // A null model is its OWN key, not a missing one: "what does this CLI offer
    // at all" is a real question, and folding it into the first model's entry
    // would file that model's list as the CLI's.
    const store = new ModelVocabularyStore({ file, now: () => 1_000 });
    store.remember(AGENT, null, VERSION, 'the whole listing');
    store.remember(AGENT, MODEL, VERSION, REPLY);
    await waitForFile();

    expect(store.read(AGENT, null, VERSION, isText)?.value).toBe(
      'the whole listing',
    );
    expect(store.read(AGENT, MODEL, VERSION, isText)?.value).toBe(REPLY);
  });

  it('refuses an entry taken under ANOTHER version of the CLI', async () => {
    // The version is the freshness signal a TTL cannot be: a model's settings
    // change when the CLI does, and an upgrade must not be answered with its
    // predecessor's list.
    seed({ [modelVocabularyKey(AGENT, MODEL)]: record() });
    const store = new ModelVocabularyStore({ file, now: () => 1_000 });

    expect(store.read(AGENT, MODEL, VERSION, isText)?.value).toBe(REPLY);
    expect(store.read(AGENT, MODEL, '2026.09.01-newer', isText)).toBeNull();
    await settle();
  });

  it('refuses to serve or store when the version could not be read', async () => {
    // A null version is the one case that check cannot be performed, so both
    // directions are closed: serving would hand an upgraded CLI the old answer,
    // and storing would only ever occupy a slot nothing can match.
    seed({ [modelVocabularyKey(AGENT, MODEL)]: record() });
    const store = new ModelVocabularyStore({ file, now: () => 1_000 });

    expect(store.read(AGENT, MODEL, null, isText)).toBeNull();

    store.remember(AGENT, 'gpt-5.4', null, REPLY);
    await settle();

    expect(store.read(AGENT, 'gpt-5.4', VERSION, isText)).toBeNull();
  });

  it('refuses a value whose SHAPE has changed under it', async () => {
    // The file outlives the build that wrote it, so a row whose shape has since
    // moved is exactly what a durable cache hands back. The guard is what turns
    // that into a re-ask instead of a picker full of rows it cannot render.
    seed({ [modelVocabularyKey(AGENT, MODEL)]: record({ value: { old: 1 } }) });
    const store = new ModelVocabularyStore({ file, now: () => 1_000 });

    expect(store.read(AGENT, MODEL, VERSION, isText)).toBeNull();
    await settle();
  });
});

describe('ModelVocabularyStore — when it stops being trusted', () => {
  it('serves an aged entry AND asks to be refreshed behind it', async () => {
    // The mechanism for every cause this app cannot observe — a plan change, a
    // `cursor-agent login` in the user's own terminal. The user waits for
    // nothing and the answer is at most one interaction behind.
    seed({ [modelVocabularyKey(AGENT, MODEL)]: record() });

    const young = new ModelVocabularyStore({ file, now: () => HOUR - 1 }).read(
      AGENT,
      MODEL,
      VERSION,
      isText,
    );
    const aged = new ModelVocabularyStore({ file, now: () => HOUR }).read(
      AGENT,
      MODEL,
      VERSION,
      isText,
    );

    expect(young?.stale).toBe(false);
    // Still SERVED — a stale answer is the best anyone has, and withholding it
    // would spend the seconds this store exists to remove.
    expect(aged?.value).toBe(REPLY);
    expect(aged?.stale).toBe(true);
    await settle();
  });

  it('stops serving entirely once the backstop is reached', async () => {
    seed({ [modelVocabularyKey(AGENT, MODEL)]: record() });

    expect(
      new ModelVocabularyStore({ file, now: () => WEEK - 1 }).read(
        AGENT,
        MODEL,
        VERSION,
        isText,
      )?.value,
    ).toBe(REPLY);
    expect(
      new ModelVocabularyStore({ file, now: () => WEEK }).read(
        AGENT,
        MODEL,
        VERSION,
        isText,
      ),
    ).toBeNull();
    await settle();
  });

  it('forgets ONE agent’s rows and leaves the other CLI’s alone', async () => {
    // What a sign-in triggers. A new account is a different set of models —
    // for THAT CLI; the other one signed in to nothing.
    const store = new ModelVocabularyStore({ file, now: () => 1_000 });
    store.remember(AGENT, null, VERSION, 'cursor listing');
    store.remember(AGENT, MODEL, VERSION, REPLY);
    store.remember('claude', null, VERSION, 'claude listing');
    await waitForFile();

    expect(store.forget(AGENT)).toBe(2);

    expect(store.read(AGENT, null, VERSION, isText)).toBeNull();
    expect(store.read(AGENT, MODEL, VERSION, isText)).toBeNull();
    expect(store.read('claude', null, VERSION, isText)?.value).toBe(
      'claude listing',
    );
  });

  it('forgets across launches, not just in memory', async () => {
    const store = new ModelVocabularyStore({ file, now: () => 1_000 });
    store.remember(AGENT, MODEL, VERSION, REPLY);
    await waitForFile();
    store.forget(AGENT);
    await settle();

    const nextLaunch = new ModelVocabularyStore({ file, now: () => 1_000 });

    expect(nextLaunch.read(AGENT, MODEL, VERSION, isText)).toBeNull();
  });
});

describe('ModelVocabularyStore — what it refuses to hold', () => {
  it('drops ONE corrupt row and keeps the rest', async () => {
    // Validated per entry rather than per file: one bad row must not cost every
    // other model its answer and six seconds each to take again.
    seed({
      [modelVocabularyKey(AGENT, 'broken')]: { version: VERSION },
      [modelVocabularyKey(AGENT, MODEL)]: record(),
    });
    const store = new ModelVocabularyStore({ file, now: () => 1_000 });

    expect(store.read(AGENT, 'broken', VERSION, isText)).toBeNull();
    expect(store.read(AGENT, MODEL, VERSION, isText)?.value).toBe(REPLY);
    await settle();
  });

  it('refuses a value too large to be a vocabulary', async () => {
    // The file cap alone is reached too late: one implausible reply would fill
    // it and evict every model the user actually works with.
    const store = new ModelVocabularyStore({ file, now: () => 1_000 });
    store.remember(AGENT, MODEL, VERSION, 'x'.repeat(256 * 1024 + 1));
    await settle();

    expect(existsSync(file)).toBe(false);
    expect(store.read(AGENT, MODEL, VERSION, isText)).toBeNull();
  });

  it('stops growing at the entry cap, keeping what is already there', async () => {
    const store = new ModelVocabularyStore({ file, now: () => 1_000 });
    for (let i = 0; i < 60; i += 1) {
      store.remember(AGENT, `model-${i}`, VERSION, REPLY);
    }
    await waitForFile();
    store.remember(AGENT, 'one-too-many', VERSION, REPLY);
    await settle();

    expect(store.read(AGENT, 'one-too-many', VERSION, isText)).toBeNull();
    // …and the sixty already there are untouched, which is the point of
    // refusing rather than evicting: the oldest may be the model in use.
    expect(store.read(AGENT, 'model-0', VERSION, isText)?.value).toBe(REPLY);
  });
});
