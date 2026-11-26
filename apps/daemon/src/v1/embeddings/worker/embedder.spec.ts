import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { chunkText, Embedder } from './embedder';

const ort = vi.hoisted(() => ({
  create: vi.fn<
    (path: string, options: unknown) => Promise<{ inputNames: string[] }>
  >(() => Promise.resolve({ inputNames: [] })),
}));

vi.mock('onnxruntime-node', () => ({
  InferenceSession: { create: ort.create },
  Tensor: class {},
}));

vi.mock('@huggingface/tokenizers', () => ({
  Tokenizer: class {},
}));

const words = (text: string): number =>
  text.split(/\s+/).filter((word) => word !== '').length;

const characters = (text: string): number => text.length;

describe('chunkText', () => {
  it('returns no chunks for an empty or blank text', () => {
    expect(chunkText('', 10, words)).toEqual([]);
    expect(chunkText('  \n\n  ', 10, words)).toEqual([]);
  });

  it('keeps a text that fits the limit whole and trimmed', () => {
    expect(chunkText('  one two three\n', 10, words)).toEqual([
      'one two three',
    ]);
  });

  it('packs whole paragraphs under the limit and starts a new chunk when the next one would not fit', () => {
    const text = ['a a a', 'b b b', 'c c c'].join('\n\n');

    expect(chunkText(text, 6, words)).toEqual(['a a a\n\nb b b', 'c c c']);
  });

  it('never returns a chunk over the limit and loses no word', () => {
    const paragraphs = Array.from({ length: 40 }, (_, p) =>
      Array.from({ length: 1 + (p % 5) }, (_, w) => `w${p}x${w}`).join(' '),
    );
    const text = paragraphs.join('\n\n');

    const chunks = chunkText(text, 7, words);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(words(chunk)).toBeLessThanOrEqual(7);
    }
    expect(chunks.join(' ').split(/\s+/)).toEqual(text.split(/\s+/));
  });

  it('cuts an oversized paragraph at its lines, never inside one', () => {
    const text = 'one two three\nfour five six\nseven eight nine';

    expect(chunkText(text, 4, words)).toEqual([
      'one two three',
      'four five six',
      'seven eight nine',
    ]);
  });

  it('cuts a single line too long for the limit by characters, keeping every character', () => {
    const text = 'x'.repeat(10);

    const chunks = chunkText(text, 4, characters);

    expect(chunks).toEqual(['xxx', 'xxx', 'xxxx']);
    expect(chunks.join('')).toBe(text);
  });
});

describe('Embedder.load', () => {
  it('turns off spin-waiting of the idle intra-op threads, which burned CPU between operators without doing work', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'embedder-load-'));
    writeFileSync(join(dir, 'tokenizer.json'), '{}');
    writeFileSync(join(dir, 'tokenizer_config.json'), '{}');
    try {
      await Embedder.load({ id: 'm', revision: 'rev1234', dir, dim: 768 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    expect(ort.create).toHaveBeenCalledTimes(1);
    const options = ort.create.mock.calls[0]?.[1] as {
      extra?: { session?: { intra_op?: { allow_spinning?: string } } };
    };
    expect(options.extra?.session?.intra_op?.allow_spinning).toBe('0');
  });
});
