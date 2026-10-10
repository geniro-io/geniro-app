import { z } from 'zod';

import { type ChatSearchHit, ChatSearchHitSchema } from './chat.types';

export const GlobalChatSearchQuerySchema = z.object({
  query: z.string().trim().min(2).max(500),
  mode: z.enum(['hybrid', 'semantic', 'keyword']).default('hybrid'),
  limit: z.number().int().min(1).max(100).default(30),
  runId: z.string().uuid().optional(),
  cwd: z.string().max(4096).optional(),
  includeArchived: z.boolean().default(true),
});
export type GlobalChatSearchQuery = z.infer<typeof GlobalChatSearchQuerySchema>;

export const GlobalChatSearchHitSchema = ChatSearchHitSchema.extend({
  runId: z.string(),
  nodeId: z.string().nullable(),
  title: z.string().nullable(),
  cwd: z.string().nullable(),
  archived: z.boolean(),
  score: z.number(),
}).meta({ id: 'GlobalChatSearchHit' });
export type GlobalChatSearchHit = z.infer<typeof GlobalChatSearchHitSchema>;

export const GlobalChatSearchResultSchema = z.object({
  hits: z.array(GlobalChatSearchHitSchema),
  mode: z.enum(['hybrid', 'semantic', 'keyword']),
  model: z.string().nullable(),
  indexing: z.boolean(),
  partialReason: z.string().nullable(),
});
export type GlobalChatSearchResult = z.infer<
  typeof GlobalChatSearchResultSchema
>;

export interface ChatEmbeddingModel {
  url: string;
  name: string;
  key: string;
}

export interface ChatSearchDocument {
  id: string;
  payload: string;
  searchText: string;
  textHash: string | null;
}

export interface ChatSearchTextChunk {
  text: string;
  textOffset: number;
}

export interface ChatEmbeddedChunk extends ChatSearchTextChunk {
  vector: number[];
}

export interface GlobalChatSearchRow {
  id: string;
  runId: string;
  nodeId: string | null;
  seq: number;
  kind: ChatSearchHit['kind'];
  role: string | null;
  searchText: string;
  createdAt: number;
  title: string | null;
  cwd: string | null;
  archivedAt: number | null;
}

export interface ChatSearchVectorRow extends GlobalChatSearchRow {
  chunkIndex: number;
  textOffset: number;
  textHash: string;
  vector: string;
}

export const SEARCH_CHATS_TOOL = 'search_chats';
