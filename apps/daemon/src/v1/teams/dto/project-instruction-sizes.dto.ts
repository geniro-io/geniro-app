import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  CustomInstructionsSchema,
  ReplyLanguageSchema,
} from '../../agents/chat.types';
import { ProjectInstructionSizesWireSchema } from '../teams.types';

/**
 * The two run settings a project's agents carry, which live in the Electron
 * process's `settings.json` and so are sent the way a run start sends them.
 */
export const measureProjectInstructionSizesSchema = z.object({
  customInstructions: CustomInstructionsSchema.optional(),
  replyLanguage: ReplyLanguageSchema.optional(),
});
export class MeasureProjectInstructionSizesDto extends createZodDto(
  measureProjectInstructionSizesSchema,
) {}

export class ProjectInstructionSizesDto extends createZodDto(
  ProjectInstructionSizesWireSchema,
) {}
