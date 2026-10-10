import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { z } from 'zod';

import type {
  ChatEmbeddedChunk,
  ChatEmbeddingModel,
  ChatSearchTextChunk,
} from '../chat-search.types';
import { searchTextHash } from '../utils/chat-search-vectors';
import { ollamaBaseUrl, ollamaRequest } from '../utils/ollama';

const TagsSchema = z.object({
  models: z.array(z.object({ name: z.string(), digest: z.string() })),
});
const DetailsSchema = z.object({
  capabilities: z.array(z.string()).default([]),
  remote_host: z.string().optional(),
  remote_model: z.string().optional(),
});
const EmbeddingsSchema = z.object({
  embeddings: z.array(z.array(z.number().finite()).min(1)),
});
const EmbeddingErrorSchema = z.object({ error: z.string() });

class EmbeddingInputTooLongError extends Error {}

@Injectable()
export class ChatEmbeddingsService implements OnApplicationShutdown {
  private readonly shutdown = new AbortController();
  private cached: {
    url: string;
    at: number;
    model: ChatEmbeddingModel | null;
  } | null = null;
  private pending: Promise<ChatEmbeddingModel | null> | null = null;

  async model(): Promise<ChatEmbeddingModel | null> {
    const url = ollamaBaseUrl();
    if (this.cached?.url === url && Date.now() - this.cached.at < 5_000) {
      return this.cached.model;
    }
    if (this.pending) {
      return this.pending;
    }
    const pending = this.discover(url);
    this.pending = pending;
    try {
      const model = await pending;
      this.cached = { url, at: Date.now(), model };
      return model;
    } finally {
      if (this.pending === pending) {
        this.pending = null;
      }
    }
  }

  async embed(model: ChatEmbeddingModel, texts: string[]): Promise<number[][]> {
    const response = await fetch(`${model.url}/api/embed`, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.any([
        this.shutdown.signal,
        AbortSignal.timeout(30_000),
      ]),
      body: JSON.stringify({
        model: model.name,
        input: texts,
        truncate: false,
      }),
    });
    if (!response.ok) {
      if (response.status === 400) {
        const error = EmbeddingErrorSchema.safeParse(
          await response.json().catch(() => null),
        );
        if (
          error.success &&
          /input length exceeds.*context length/i.test(error.data.error)
        ) {
          throw new EmbeddingInputTooLongError(
            'The input exceeds the local embedding model context. Try a shorter query.',
          );
        }
      }
      throw new Error(`Local embeddings returned HTTP ${response.status}.`);
    }
    const { embeddings } = EmbeddingsSchema.parse(await response.json());
    if (
      embeddings.length !== texts.length ||
      embeddings.some(
        (vector) =>
          vector.length !== embeddings[0]?.length ||
          !vector.some((value) => value !== 0),
      )
    ) {
      throw new Error('Ollama returned inconsistent embedding vectors.');
    }
    return embeddings;
  }

  async embedChunks(
    model: ChatEmbeddingModel,
    chunks: ChatSearchTextChunk[],
  ): Promise<ChatEmbeddedChunk[]> {
    try {
      const vectors = await this.embed(
        model,
        chunks.map((chunk) => chunk.text),
      );
      return chunks.map((chunk, index) => ({
        ...chunk,
        vector: vectors[index]!,
      }));
    } catch (error) {
      if (!(error instanceof EmbeddingInputTooLongError)) {
        throw error;
      }
      if (chunks.length > 1) {
        const embedded: ChatEmbeddedChunk[] = [];
        for (const chunk of chunks) {
          embedded.push(...(await this.embedChunks(model, [chunk])));
        }
        return embedded;
      }
      const chunk = chunks[0];
      if (!chunk || chunk.text.length <= 1) {
        throw error;
      }
      const middle = Math.floor(chunk.text.length / 2);
      const overlap = Math.min(100, Math.floor(chunk.text.length / 4));
      const secondStart = middle - overlap;
      return this.embedChunks(model, [
        {
          text: chunk.text.slice(0, middle + overlap),
          textOffset: chunk.textOffset,
        },
        {
          text: chunk.text.slice(secondStart),
          textOffset: chunk.textOffset + secondStart,
        },
      ]);
    }
  }

  onApplicationShutdown(): void {
    this.shutdown.abort();
  }

  private async discover(url: string): Promise<ChatEmbeddingModel | null> {
    const { models } = TagsSchema.parse(await ollamaRequest(url, '/api/tags'));
    for (const model of models.sort((a, b) => a.name.localeCompare(b.name))) {
      if (/(?:[:-]cloud)$/u.test(model.name)) {
        continue;
      }
      const details = DetailsSchema.parse(
        await ollamaRequest(url, '/api/show', model.name),
      );
      if (
        details.remote_host ||
        details.remote_model ||
        !details.capabilities.includes('embedding')
      ) {
        continue;
      }
      return {
        url,
        name: model.name,
        key: searchTextHash(
          `${url}\n${model.name}\n${model.digest}\nchunks-v3`,
        ),
      };
    }
    return null;
  }
}
