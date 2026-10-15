import { createContext } from 'react';

/**
 * Sends a recommendations card's Apply (`POST /v1/chats/:runId/recommendations/apply`).
 * Provided by `Chats`, which holds the API client; a card drawn without it
 * (a story, a spec) is read-only.
 */
export type RecommendationsApplier = (
  runId: string,
  cardSeq: number,
  ids: string[],
) => Promise<void>;

export const RecommendationsApplyContext =
  createContext<RecommendationsApplier | null>(null);
