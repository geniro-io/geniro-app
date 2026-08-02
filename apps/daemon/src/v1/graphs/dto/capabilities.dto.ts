import { createZodDto } from 'nestjs-zod';

import { CapabilitiesWireSchema } from '../graphs.types';

/**
 * `GET /v1/capabilities` — machine-level feature availability the builder and
 * the chat approval selector read (the claude permission-mode probe).
 * Response-only; the route takes no input.
 */
export class CapabilitiesDto extends createZodDto(CapabilitiesWireSchema) {}
