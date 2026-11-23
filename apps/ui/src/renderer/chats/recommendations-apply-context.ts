import { createContext } from 'react';

import type { ProjectRef } from '../projects/use-projects';

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

export type SystemApplyAction = 'cards' | 'implement' | 'report';

/**
 * Sends a system analysis report's button (`POST /v1/system-analyses/:runId/apply`):
 * geniro files the picked G- items as board cards in the picked project, and
 * starts them for Implement right away. Provided by `Chats` with the projects
 * a card may go to.
 */
export interface SystemRecommendationsApplier {
  projects: readonly ProjectRef[];
  apply: (
    runId: string,
    cardSeq: number,
    action: SystemApplyAction,
    ids: string[],
    projectId: string | null,
  ) => Promise<{ recorded: boolean }>;
}

export const SystemRecommendationsApplyContext =
  createContext<SystemRecommendationsApplier | null>(null);
