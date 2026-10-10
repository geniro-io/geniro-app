import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  GlobalChatSearchQuerySchema,
  GlobalChatSearchResultSchema,
} from '../chat-search.types';

export class GlobalChatSearchQueryDto extends createZodDto(
  GlobalChatSearchQuerySchema.extend({
    limit: z.coerce.number().int().min(1).max(100).default(30),
    includeArchived: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .default(true),
  }),
) {}

export class GlobalChatSearchResultDto extends createZodDto(
  GlobalChatSearchResultSchema,
) {}
