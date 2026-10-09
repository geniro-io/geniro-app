import { createZodDto } from 'nestjs-zod';

import { LineSnapshotAckSchema, LineSnapshotWireSchema } from '../stats.types';

/**
 * The body of `POST /v1/stats/line-snapshots`: one thread's measured change totals.
 *
 * Validated by the global pipe. What a snapshot MEANS, and whether its run may take
 * one, is decided by `StatsService.recordLinesSnapshot`.
 */
export class LineSnapshotDto extends createZodDto(LineSnapshotWireSchema) {}

/** The acknowledgement a recorded measurement earns. */
export class LineSnapshotAckDto extends createZodDto(LineSnapshotAckSchema) {}
