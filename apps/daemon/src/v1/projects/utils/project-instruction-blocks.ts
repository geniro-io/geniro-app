import { parseJsonColumn } from '../../agents/utils/json-util';
import type { Project } from '../entity/project.entity';
import {
  MAX_PROJECT_INSTRUCTION_BLOCKS,
  PROJECT_INSTRUCTIONS_MAX,
  type ProjectInstructionBlock,
  ProjectInstructionBlockSchema,
} from '../projects.types';

/** The id and title a project's instructions from before blocks read under. */
export const LEGACY_BLOCK_ID = 'instructions';
export const LEGACY_BLOCK_TITLE = 'Instructions';

/**
 * A project's blocks: the stored list, else its instructions from before
 * blocks as one block, else none. An entry that does not parse is dropped.
 */
export function projectBlocksOf(
  project: Pick<Project, 'instructions' | 'instructionBlocks'>,
): ProjectInstructionBlock[] {
  if (project.instructionBlocks !== null) {
    const stored = parseJsonColumn(project.instructionBlocks);
    return Array.isArray(stored)
      ? stored.flatMap((entry) => {
          const parsed = ProjectInstructionBlockSchema.safeParse(entry);
          return parsed.success ? [parsed.data] : [];
        })
      : [];
  }
  return project.instructions === null
    ? []
    : [
        {
          id: LEGACY_BLOCK_ID,
          title: LEGACY_BLOCK_TITLE,
          text: project.instructions,
        },
      ];
}

/** What a run receives: every block's text in order, titles left out; null for none. */
export function joinedBlockTexts(
  blocks: readonly ProjectInstructionBlock[],
): string | null {
  const texts = blocks.map((block) => block.text.trim()).filter(Boolean);
  return texts.length === 0 ? null : texts.join('\n\n');
}

/** How many characters a run receives from these blocks — what {@link PROJECT_INSTRUCTIONS_MAX} bounds. */
export function instructionsLength(
  blocks: readonly ProjectInstructionBlock[],
): number {
  return joinedBlockTexts(blocks)?.length ?? 0;
}

/** A block as an agent sends it: an id alone keeps that block as it stands, a missing title or text keeps that part. */
export interface ProjectBlockInput {
  id: string;
  title?: string;
  text?: string;
}

/**
 * The block list an agent's change describes, filled in from the blocks as
 * they stand: a kept block is copied whole, a partial one keeps the part it
 * leaves out. A new block needs its text.
 */
export function resolveProjectBlocks(
  inputs: readonly ProjectBlockInput[],
  current: readonly ProjectInstructionBlock[],
):
  | { ok: true; blocks: ProjectInstructionBlock[] }
  | { ok: false; message: string } {
  const blocks: ProjectInstructionBlock[] = [];
  for (const input of inputs) {
    const standing = current.find((block) => block.id === input.id);
    if (standing === undefined && input.text === undefined) {
      return {
        ok: false,
        message: `block ${input.id} is not one of the project's blocks — a new block needs its text`,
      };
    }
    blocks.push({
      id: input.id,
      title: input.title ?? standing?.title ?? '',
      text: input.text ?? standing?.text ?? '',
    });
  }
  return { ok: true, blocks };
}

/** An agent's block change filled in and checked, or why it cannot be written, with the figures for a total too long. */
export type CheckedProjectChange =
  | { ok: true; blocks: ProjectInstructionBlock[] }
  | {
      ok: false;
      error: 'UNKNOWN_BLOCK' | 'INVALID_BLOCKS' | 'INSTRUCTIONS_TOO_LONG';
      message: string;
      figures?: { chars: number; maxChars: number; charsNow: number };
    };

/**
 * An agent's change to a project's blocks filled in from the blocks as they
 * stand and held to the rules the write enforces, so a change the write would
 * refuse never reaches a card the user approves.
 */
export function checkedProjectChange(
  inputs: readonly ProjectBlockInput[],
  current: readonly ProjectInstructionBlock[],
): CheckedProjectChange {
  const resolved = resolveProjectBlocks(inputs, current);
  if (!resolved.ok) {
    return { ok: false, error: 'UNKNOWN_BLOCK', message: resolved.message };
  }
  const refusal = projectBlocksRefusal(resolved.blocks);
  if (refusal === null) {
    return { ok: true, blocks: resolved.blocks };
  }
  return refusal.tooLong
    ? {
        ok: false,
        error: 'INSTRUCTIONS_TOO_LONG',
        message: `${refusal.message} — nothing was put to the user; shorten the change or move detail into the repository and point to it`,
        figures: {
          chars: instructionsLength(resolved.blocks),
          maxChars: PROJECT_INSTRUCTIONS_MAX,
          charsNow: instructionsLength(current),
        },
      }
    : { ok: false, error: 'INVALID_BLOCKS', message: refusal.message };
}

/** Why a writer may not store a block list; `tooLong` when only the total is over. */
export interface ProjectBlocksRefusal {
  tooLong: boolean;
  message: string;
}

/**
 * Why these blocks cannot be stored — too many, a shared id, a block its schema
 * refuses, or texts that together run past the bound — or null when they can.
 * Refused whole, never trimmed.
 */
export function projectBlocksRefusal(
  blocks: readonly ProjectInstructionBlock[],
): ProjectBlocksRefusal | null {
  if (blocks.length > MAX_PROJECT_INSTRUCTION_BLOCKS) {
    return {
      tooLong: false,
      message: `a project holds at most ${MAX_PROJECT_INSTRUCTION_BLOCKS} instruction blocks`,
    };
  }
  if (new Set(blocks.map((block) => block.id)).size !== blocks.length) {
    return { tooLong: false, message: 'two instruction blocks share an id' };
  }
  for (const block of blocks) {
    const result = ProjectInstructionBlockSchema.safeParse(block);
    if (!result.success) {
      return {
        tooLong: false,
        message: `instruction block ${block.id}: ${result.error.issues[0]?.message ?? 'invalid'}`,
      };
    }
  }
  const length = instructionsLength(blocks);
  if (length > PROJECT_INSTRUCTIONS_MAX) {
    return {
      tooLong: true,
      message: `the instructions may hold at most ${PROJECT_INSTRUCTIONS_MAX} characters in all; these hold ${length}, ${length - PROJECT_INSTRUCTIONS_MAX} over`,
    };
  }
  return null;
}

/**
 * The blocks as one document, each under a `## Title` heading — what the change
 * log keeps and an analysis's card diffs, so a change names its block. Null for
 * none.
 */
export function blocksDocument(
  blocks: readonly ProjectInstructionBlock[],
): string | null {
  const parts = blocks.flatMap((block) => {
    const title = block.title.trim();
    const text = block.text.trim();
    if (!title && !text) {
      return [];
    }
    return [
      [title ? `## ${title}` : null, text || null]
        .filter((part): part is string => part !== null)
        .join('\n\n'),
    ];
  });
  return parts.length === 0 ? null : parts.join('\n\n');
}
