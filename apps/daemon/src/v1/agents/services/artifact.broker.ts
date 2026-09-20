import { Injectable } from '@nestjs/common';

import type { HostArtifact, HostArtifactOutcome } from '../chat.types';
import { HostSinkBroker } from './host-sink.broker';

/**
 * Publishes a host-rendered HTML page (`HOST_ARTIFACT_TOOL`) into the run's own
 * transcript and artifact panel.
 *
 * A rendezvous and nothing more — the mechanics, and why they are what they are,
 * live in {@link HostSinkBroker}. Fire-and-forget like the gallery and the chart
 * beside it: the agent is not waiting on a person, only on the page being
 * durable and the row being written. The document itself is fetched later, by
 * the renderer, over the artifact route.
 */
export type ArtifactPublisher = (
  artifact: HostArtifact,
) => Promise<HostArtifactOutcome>;

@Injectable()
export class ArtifactBroker extends HostSinkBroker<ArtifactPublisher> {
  /** Whether this node can currently publish — gates the tool listing. */
  canPublish(runId: string, nodeId: string): boolean {
    return this.has(runId, nodeId);
  }

  /** Publish the page and resolve with what happened. Never throws. */
  async publish(
    runId: string,
    nodeId: string,
    artifact: HostArtifact,
  ): Promise<HostArtifactOutcome> {
    return this.deliver(
      runId,
      nodeId,
      'no turn is running that could show it',
      'publish an artifact',
      (publisher) => publisher(artifact),
    );
  }
}
