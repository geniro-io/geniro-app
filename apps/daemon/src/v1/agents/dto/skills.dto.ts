import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { AgentKindSchema } from '../../runs/runs.types';
import {
  AgentCacheResetWireSchema,
  AgentSessionListingWireSchema,
  AgentSkillWireSchema,
  AgentVocabularyWireSchema,
} from '../chat.types';

/**
 * Query for the skills listing — which agent's on-disk skill convention to
 * scan, and the project folder to scan it in (validated server-side by
 * `resolveValidCwd`: must exist and be a directory).
 */
export const listSkillsQuerySchema = z.object({
  agent: AgentKindSchema,
  cwd: z.string().min(1),
  /**
   * The run's agent config directory — its ACCOUNT — or absent for the CLI's
   * own. Every answer on these routes is an account fact (which models exist,
   * which levels and windows they take, which plugins the CLI reports), so
   * without it one subscription's vocabulary was cached under the CLI's name
   * and served to every other. Optional and validated server-side, the same
   * shape `/v1/agents/mcp` already carries.
   */
  configDir: z.string().min(1).optional(),
});
export class ListSkillsQueryDto extends createZodDto(listSkillsQuerySchema) {}

/** One skill / slash command an agent accepts in a working directory. */
export class AgentSkillDto extends createZodDto(AgentSkillWireSchema) {}

/**
 * Query for the vocabulary answer: which CLI, which of its MODELS, and which
 * account.
 *
 * `model` is optional and its absence is a real question rather than a missing
 * argument: "what does this CLI offer at all" is what a picker asks before a
 * model has been chosen. The effort part then answers with the CLI-wide
 * superset, and the context-window and parameter parts with the sentence
 * saying a model must be named — their axes exist per model (twelve of a cursor
 * account's thirty-four offer windows at all, and `optimize_for` exists on
 * exactly one). The model list itself never depends on it.
 */
export const listVocabularyQuerySchema = z.object({
  agent: AgentKindSchema,
  model: z.string().min(1).optional(),
  /**
   * The run's agent config directory — its ACCOUNT — or absent for the CLI's
   * own. Every part of this answer is an account fact (which models exist,
   * which levels and windows they take), so without it one subscription's
   * vocabulary was cached under the CLI's name and served to every other.
   * Optional and validated server-side, the same shape `/v1/agents/mcp`
   * already carries.
   */
  configDir: z.string().min(1).optional(),
});
export class ListVocabularyQueryDto extends createZodDto(
  listVocabularyQuerySchema,
) {}

/** The models, and the chosen model's levels, windows and parameters. */
export class AgentVocabularyDto extends createZodDto(
  AgentVocabularyWireSchema,
) {}

/** How much a manual cache reset threw away. */
export class AgentCacheResetDto extends createZodDto(
  AgentCacheResetWireSchema,
) {}

/**
 * Query for the sessions listing: which CLI to ask, optionally narrowed to one
 * folder and one profile.
 *
 * `cwd` is optional here where the skills listing requires it, and that is the
 * feature rather than an inconsistency: "everything I have ever worked on" is a
 * real question for a picker whose whole job is finding an old conversation,
 * while a skill listing only means anything relative to a folder.
 */
export const listAgentSessionsQuerySchema = z.object({
  agent: AgentKindSchema,
  cwd: z.string().min(1).optional(),
  configDir: z.string().min(1).optional(),
  /**
   * What to search for, or absent for everything.
   *
   * Answered by the ADAPTER rather than filtered out of a full listing, and
   * that is the whole reason it is a route parameter: only the adapter can
   * reach what its CLI stores, so only the adapter can match on what was SAID
   * in a conversation rather than on the one line a picker row shows. A caller
   * filtering the response could never find a thread by its middle.
   *
   * Bounded like every other CLI-vocabulary string this app accepts — a
   * ceiling generous enough for a real pasted search phrase, never a narrow
   * filter on how somebody searches. The one caller is the session picker's
   * own text box behind the loopback token guard, so this is a sanity limit
   * rather than a defense against an adversarial caller. This 200-char
   * ceiling is also what `session-search.utils.ts`'s `MAX_SEARCH_TERMS` is
   * sized against — raising one without the other is how a real pasted
   * phrase comes to lose words again.
   */
  query: z.string().min(1).max(200).optional(),
});
export class ListAgentSessionsQueryDto extends createZodDto(
  listAgentSessionsQuerySchema,
) {}

/** The conversations one CLI holds, and why the list may not be everything. */
export class AgentSessionListingDto extends createZodDto(
  AgentSessionListingWireSchema,
) {}
