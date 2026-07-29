import { readFileSync } from 'node:fs';

import type { TurnImage } from '../adapter.types';

/** One Messages-API image content block, as claude's stream-json input takes it. */
interface ClaudeImageBlock {
  type: 'image';
  source: { type: 'base64'; media_type: string; data: string };
}

/**
 * Read each attached image off disk into a base64 content block.
 *
 * A missing file THROWS rather than being skipped: dropping it would leave the
 * user watching an agent answer confidently about a screenshot it never
 * received. The throw lands in `AgentAdapter.start`'s synchronous path, which
 * disposes the turn's resources and surfaces the failure.
 */
export function buildImageBlocks(images?: TurnImage[]): ClaudeImageBlock[] {
  return (images ?? []).map((image) => ({
    type: 'image' as const,
    source: {
      type: 'base64' as const,
      media_type: image.mediaType,
      data: readFileSync(image.path).toString('base64'),
    },
  }));
}
