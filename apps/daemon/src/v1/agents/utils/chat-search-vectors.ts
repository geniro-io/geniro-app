import { createHash } from 'node:crypto';

import type { ChatSearchTextChunk } from '../chat-search.types';

export const SEARCH_CHUNK_SIZE = 2_000;
export const SEARCH_CHUNK_STEP = 1_800;

export function searchTextHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function searchChunks(text: string): ChatSearchTextChunk[] {
  const chunks: ChatSearchTextChunk[] = [];
  for (let start = 0; start < text.length; start += SEARCH_CHUNK_STEP) {
    chunks.push({
      text: text.slice(start, start + SEARCH_CHUNK_SIZE),
      textOffset: start,
    });
    if (start + SEARCH_CHUNK_SIZE >= text.length) {
      break;
    }
  }
  return chunks;
}

export function cosineSimilarity(
  a: readonly number[],
  b: readonly number[],
): number {
  if (a.length !== b.length || a.length === 0) {
    return 0;
  }
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i]!;
    const bv = b[i]!;
    dot += av * bv;
    aNorm += av ** 2;
    bNorm += bv ** 2;
  }
  return aNorm && bNorm ? dot / Math.sqrt(aNorm * bNorm) : 0;
}
