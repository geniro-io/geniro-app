import { createZodDto } from 'nestjs-zod';

import {
  AnswerHeldRunsSchema,
  HeldRunsAnsweredSchema,
  HeldRunsSchema,
} from '../teams.types';

export class HeldRunsDto extends createZodDto(HeldRunsSchema) {}

export class AnswerHeldRunsDto extends createZodDto(AnswerHeldRunsSchema) {}

export class HeldRunsAnsweredDto extends createZodDto(HeldRunsAnsweredSchema) {}
