import { parseJsonColumn } from '../../agents/utils/json-util';
import type { Project } from '../entity/project.entity';
import {
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
