import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  ResourceAlertConfigSchema,
  ResourceAlertsWireSchema,
  StoppedResourceAlertCommandSchema,
} from '../chat.types';

/** The settings Electron main pushes; replaces whatever the daemon held. */
export class ResourceAlertConfigDto extends createZodDto(
  ResourceAlertConfigSchema,
) {}

/** The settings the daemon now holds. */
export class ResourceAlertConfigAckDto extends createZodDto(
  z.object(ResourceAlertConfigSchema.shape),
) {}

export class ResourceAlertsDto extends createZodDto(ResourceAlertsWireSchema) {}

export class StoppedResourceAlertCommandDto extends createZodDto(
  StoppedResourceAlertCommandSchema,
) {}
