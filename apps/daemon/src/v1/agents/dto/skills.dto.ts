import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { AgentKindSchema } from '../../runs/runs.types';
import {
  AgentContextWindowListingWireSchema,
  AgentEffortListingWireSchema,
  AgentModelWireSchema,
  AgentSessionListingWireSchema,
  AgentSkillWireSchema,
} from '../chat.types';

/**
 * Query for the skills listing — which agent's on-disk skill convention to
 * scan, and the project folder to scan it in (validated server-side by
 * `resolveValidCwd`: must exist and be a directory).
 */
export const listSkillsQuerySchema = z.object({
  agent: AgentKindSchema,
  cwd: z.string().min(1),
});
export class ListSkillsQueryDto extends createZodDto(listSkillsQuerySchema) {}

/** One skill / slash command an agent accepts in a working directory. */
export class AgentSkillDto extends createZodDto(AgentSkillWireSchema) {}

/** Query for the model listing — which agent CLI to ask. */
export const listModelsQuerySchema = z.object({ agent: AgentKindSchema });
export class ListModelsQueryDto extends createZodDto(listModelsQuerySchema) {}

/** One model an agent CLI accepts for `--model`. */
export class AgentModelDto extends createZodDto(AgentModelWireSchema) {}

/**
 * Query for the effort listing: which CLI, and — the part that makes the answer
 * exact — which of its MODELS.
 *
 * `model` is optional and its absence is a real question rather than a missing
 * argument: "what does this CLI offer at all" is what the picker asks before a
 * model has been chosen, and it answers with the CLI-wide superset. Naming a
 * model narrows it to what that model actually takes, which for cursor is a
 * different list per model and for claude is the same one.
 */
export const listEffortsQuerySchema = z.object({
  agent: AgentKindSchema,
  model: z.string().min(1).optional(),
});
export class ListEffortsQueryDto extends createZodDto(listEffortsQuerySchema) {}

/** The levels one model offers, or the reason it offers none. */
export class AgentEffortListingDto extends createZodDto(
  AgentEffortListingWireSchema,
) {}

/**
 * Query for the context-window listing — the same shape as the effort one, and
 * `model` matters MORE here: the sizes belong to the model outright (twelve of
 * a cursor account's thirty-four offer the axis at all, with three different
 * vocabularies among them), so with no model named there is nothing to list and
 * the answer is the sentence saying so.
 */
export const listContextWindowsQuerySchema = z.object({
  agent: AgentKindSchema,
  model: z.string().min(1).optional(),
});
export class ListContextWindowsQueryDto extends createZodDto(
  listContextWindowsQuerySchema,
) {}

/** The window sizes one model offers, or the reason it offers none. */
export class AgentContextWindowListingDto extends createZodDto(
  AgentContextWindowListingWireSchema,
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
