import { Injectable } from '@nestjs/common';

import type { HostGallery, HostGalleryOutcome } from '../chat.types';
import { HostSinkBroker } from './host-sink.broker';

/**
 * Shows a host-rendered image gallery (`HOST_GALLERY_TOOL`) in the run's own
 * transcript.
 *
 * A rendezvous and nothing more — the mechanics, and why they are what they
 * are, live in {@link HostSinkBroker}. Fire-and-forget like the chart beside
 * it: the agent is not waiting on a person, only on the row being durable. The
 * pictures themselves are fetched later, by the renderer, over the image route.
 */
export type GalleryDrawer = (
  gallery: HostGallery,
) => Promise<HostGalleryOutcome>;

@Injectable()
export class GalleryBroker extends HostSinkBroker<GalleryDrawer> {
  /** Whether this node can currently draw — gates the tool listing. */
  canDraw(runId: string, nodeId: string): boolean {
    return this.has(runId, nodeId);
  }

  /** Show the gallery and resolve with what happened. Never throws. */
  async draw(
    runId: string,
    nodeId: string,
    gallery: HostGallery,
  ): Promise<HostGalleryOutcome> {
    return this.deliver(
      runId,
      nodeId,
      'no turn is running that could show it',
      'show a gallery',
      (drawer) => drawer(gallery),
    );
  }
}
