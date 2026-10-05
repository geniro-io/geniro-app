import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { RunGroupColorSchema } from '../chat.types';

export const setRunColorSchema = z.object({
  /**
   * The colour the row should END in, or null to clear it — never a toggle,
   * for `setRunPinnedSchema`'s reason: a replayed request must land the same.
   */
  color: RunGroupColorSchema.nullable(),
});
export class SetRunColorDto extends createZodDto(setRunColorSchema) {}
