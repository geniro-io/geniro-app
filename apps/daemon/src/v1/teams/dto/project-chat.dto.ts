import { createZodDto } from 'nestjs-zod';

import {
  ProjectChatsDiscardedSchema,
  StartProjectChatSchema,
} from '../teams.types';

/** The composer settings a project page's chat panel opens its conversation with. */
export class StartProjectChatDto extends createZodDto(StartProjectChatSchema) {}

/** How many of a project's own chats a discard destroyed. */
export class ProjectChatsDiscardedDto extends createZodDto(
  ProjectChatsDiscardedSchema,
) {}
