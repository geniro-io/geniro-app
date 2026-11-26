import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Tokenizer } from '@huggingface/tokenizers';
import { InferenceSession, Tensor } from 'onnxruntime-node';

import {
  EMBEDDING_BATCH_SIZE,
  EMBEDDING_MAX_TOKENS,
  type EmbeddingModelRef,
} from '../embeddings.types';

const QUERY_PROMPT = 'task: search result | query: ';
const DOCUMENT_PROMPT = 'title: none | text: ';
const UNUSED_MODALITIES = [
  'image_features',
  'video_features',
  'audio_features',
];
const UNUSED_FEATURE_WIDTH = 512;

export type EmbedKind = 'query' | 'document';

/**
 * One loaded model: its tokenizer and ONNX session. The session options keep
 * onnxruntime away from the large aligned allocations that crash it under
 * Electron's Node (arena growth, the memory-pattern plan buffer), and its idle
 * pool threads block between operators instead of spin-waiting for them.
 */
export class Embedder {
  private constructor(
    readonly model: EmbeddingModelRef,
    private readonly tokenizer: Tokenizer,
    private readonly session: InferenceSession,
  ) {}

  static async load(model: EmbeddingModelRef): Promise<Embedder> {
    const tokenizer = new Tokenizer(
      JSON.parse(
        readFileSync(join(model.dir, 'tokenizer.json'), 'utf8'),
      ) as object,
      JSON.parse(
        readFileSync(join(model.dir, 'tokenizer_config.json'), 'utf8'),
      ) as object,
    );
    const session = await InferenceSession.create(
      join(model.dir, 'model_quantized.onnx'),
      {
        executionProviders: ['cpu'],
        intraOpNumThreads: 4,
        interOpNumThreads: 1,
        enableCpuMemArena: false,
        enableMemPattern: false,
        extra: { session: { intra_op: { allow_spinning: '0' } } },
      },
    );
    return new Embedder(model, tokenizer, session);
  }

  tokenCount(text: string): number {
    return this.tokenizer.encode(text, { add_special_tokens: false }).ids
      .length;
  }

  async embed(
    texts: readonly string[],
    kind: EmbedKind,
  ): Promise<Float32Array[]> {
    const vectors: Float32Array[] = [];
    for (let start = 0; start < texts.length; start += EMBEDDING_BATCH_SIZE) {
      const batch = texts.slice(start, start + EMBEDDING_BATCH_SIZE);
      vectors.push(...(await this.embedBatch(batch, kind)));
    }
    return vectors;
  }

  async release(): Promise<void> {
    await this.session.release();
  }

  private async embedBatch(
    texts: readonly string[],
    kind: EmbedKind,
  ): Promise<Float32Array[]> {
    const prompt = kind === 'query' ? QUERY_PROMPT : DOCUMENT_PROMPT;
    const rows = texts.map((text) =>
      this.tokenizer.encode(prompt + text).ids.slice(0, EMBEDDING_MAX_TOKENS),
    );
    const width = Math.max(1, ...rows.map((row) => row.length));
    const inputIds = new BigInt64Array(rows.length * width);
    const attention = new BigInt64Array(rows.length * width);
    rows.forEach((row, b) => {
      row.forEach((id, j) => {
        inputIds[b * width + j] = BigInt(id);
        attention[b * width + j] = 1n;
      });
    });
    const feeds: Record<string, Tensor> = {
      input_ids: new Tensor('int64', inputIds, [rows.length, width]),
      attention_mask: new Tensor('int64', attention, [rows.length, width]),
    };
    for (const name of UNUSED_MODALITIES) {
      if (this.session.inputNames.includes(name)) {
        feeds[name] = new Tensor('float32', new Float32Array(0), [
          0,
          UNUSED_FEATURE_WIDTH,
        ]);
      }
    }
    const output = await this.session.run(feeds);
    const embedding = output.sentence_embedding;
    if (!embedding) {
      throw new Error('the model returned no sentence_embedding');
    }
    const dim = embedding.dims[1] ?? 0;
    if (dim !== this.model.dim) {
      throw new Error(
        `the model returned ${dim} dimensions, expected ${this.model.dim}`,
      );
    }
    const data = embedding.data as Float32Array;
    return rows.map((_, b) =>
      normalized(data.subarray(b * dim, (b + 1) * dim)),
    );
  }
}

export function normalized(vector: Float32Array): Float32Array {
  let sum = 0;
  for (const value of vector) {
    sum += value * value;
  }
  const norm = Math.sqrt(sum) || 1;
  return Float32Array.from(vector, (value) => value / norm);
}

/**
 * Split a text into pieces the model reads whole: paragraphs packed up to the
 * token limit, an oversized paragraph cut by lines and then by characters.
 */
export function chunkText(
  text: string,
  maxTokens: number,
  countTokens: (piece: string) => number,
): string[] {
  const trimmed = text.trim();
  if (trimmed === '') {
    return [];
  }
  if (countTokens(trimmed) <= maxTokens) {
    return [trimmed];
  }
  const pieces = trimmed
    .split(/\n{2,}/)
    .flatMap((paragraph) =>
      splitOversized(paragraph.trim(), maxTokens, countTokens),
    )
    .filter((piece) => piece !== '');
  const chunks: string[] = [];
  let current = '';
  for (const piece of pieces) {
    const candidate = current === '' ? piece : `${current}\n\n${piece}`;
    if (current !== '' && countTokens(candidate) > maxTokens) {
      chunks.push(current);
      current = piece;
    } else {
      current = candidate;
    }
  }
  if (current !== '') {
    chunks.push(current);
  }
  return chunks;
}

function splitOversized(
  paragraph: string,
  maxTokens: number,
  countTokens: (piece: string) => number,
): string[] {
  if (countTokens(paragraph) <= maxTokens) {
    return [paragraph];
  }
  const lines = paragraph.split('\n').filter((line) => line.trim() !== '');
  if (lines.length > 1) {
    return lines.flatMap((line) =>
      splitOversized(line, maxTokens, countTokens),
    );
  }
  const pieces: string[] = [];
  let rest = paragraph;
  while (rest !== '') {
    let size = Math.min(rest.length, maxTokens * 4);
    while (size > 1 && countTokens(rest.slice(0, size)) > maxTokens) {
      size = Math.floor(size * 0.75);
    }
    pieces.push(rest.slice(0, size));
    rest = rest.slice(size);
  }
  return pieces;
}
