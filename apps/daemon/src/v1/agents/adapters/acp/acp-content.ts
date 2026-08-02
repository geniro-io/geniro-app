import { readFileSync } from 'node:fs';

import type { TurnImage } from '../adapter.types';
import type { AcpImageBlock } from './acp.types';

/**
 * Read each attached image off disk into an ACP `image` content block.
 *
 * ACP's own content-block vocabulary, so this is protocol code and not any one
 * CLI's: an agent that advertises `promptCapabilities.image` accepts these
 * inside `session/prompt` and SEES the picture, with no filesystem round-trip
 * and no permission gate in between.
 *
 * A missing file THROWS rather than being skipped — the same contract the
 * claude path holds, for the same reason: dropping it would leave the user
 * watching an agent answer confidently about a screenshot it never received.
 * The driver is constructed inside `AgentAdapter.start`'s synchronous try, so
 * the throw lands where a bad argv does, disposing the turn's resources.
 */
export function buildAcpImageBlocks(images?: TurnImage[]): AcpImageBlock[] {
  return (images ?? []).map((image) => ({
    type: 'image' as const,
    mimeType: image.mediaType,
    data: readFileSync(image.path).toString('base64'),
  }));
}
