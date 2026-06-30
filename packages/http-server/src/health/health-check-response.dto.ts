import { createZodDto } from 'nestjs-zod';
import z from 'zod';

import { HealthStatus } from '../http-server.types';

export const HealthCheckResponseSchema = z
  .object({
    status: z.enum(HealthStatus),
    version: z.string(),
  })
  .strip();

export class HealthCheckResponseDto extends createZodDto(
  HealthCheckResponseSchema,
) {}
