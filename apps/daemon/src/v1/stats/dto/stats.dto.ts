import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { UsageStatsWireSchema } from '../stats.types';

/**
 * HTTP DTOs for the stats route.
 *
 * Inputs are validated by the global `ZodValidationPipe` the http-server
 * installs; the response is declared with `@ZodResponse` on the controller,
 * which type-checks the handler's return value, serializes it through the
 * schema, and publishes the schema to the OpenAPI document the renderer's
 * client is generated from.
 */
export const usageStatsQuerySchema = z.object({
  /**
   * Both ends are optional, and each omission means something different: no
   * `to` is "up to now", no `from` is "as far back as the ledger goes". The
   * page's presets send both; a caller exploring the API can send neither and
   * get the whole history.
   *
   * ISO-8601 STRINGS, validated here and turned into instants by the service.
   * Not `z.coerce.date()`, which types the field as a `Date` — a type JSON
   * Schema cannot express, so nestjs-zod refuses to publish the route and the
   * daemon fails its own boot check rather than shipping a generated client
   * with a hole in it. Validating the format here still keeps the thing this
   * guards against out: an unparseable value is a 400, never an `Invalid Date`
   * that reaches the query, matches no rows, and renders as a period in which
   * nothing was spent.
   *
   * An explicit UTC offset is accepted as well as `Z`, so a caller can name a
   * local midnight without converting it first.
   */
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});
export class UsageStatsQueryDto extends createZodDto(usageStatsQuerySchema) {}

/** What the app has spent over a period — see {@link UsageStatsWireSchema}. */
export class UsageStatsDto extends createZodDto(UsageStatsWireSchema) {}
