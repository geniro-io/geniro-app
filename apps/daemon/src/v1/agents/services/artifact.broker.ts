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
  /**
   * The caller key of the conversation that published it — which call of a
   * workflow node it came from.
   */
  caller: string,
) => Promise<HostArtifactOutcome>;

@Injectable()
export class ArtifactBroker extends HostSinkBroker<ArtifactPublisher> {
  /** Runs whose publishers a workflow executor installed, by their mark. */
  private readonly workflowRuns = new Map<string, symbol>();

  /** Whether this node can currently publish — gates the tool listing. */
  canPublish(runId: string, nodeId: string): boolean {
    return this.has(runId, nodeId);
  }

  /**
   * Mark `runId` as a WORKFLOW run until the returned disposer runs — what the
   * tool's description keys its run-wide wording on. Identity-checked like
   * {@link register}'s disposer, so a late one never unmarks a newer mark.
   */
  markWorkflowRun(runId: string): () => void {
    const mark = Symbol(runId);
    this.workflowRuns.set(runId, mark);
    return () => {
      if (this.workflowRuns.get(runId) === mark) {
        this.workflowRuns.delete(runId);
      }
    };
  }

  /** Whether `runId` is a workflow run — every agent of it may publish. */
  inWorkflowRun(runId: string): boolean {
    return this.workflowRuns.has(runId);
  }

  /** Publish the page and resolve with what happened. Never throws. */
  async publish(
    runId: string,
    nodeId: string,
    artifact: HostArtifact,
    caller: string,
  ): Promise<HostArtifactOutcome> {
    return this.deliver(
      runId,
      nodeId,
      'no turn is running that could show it',
      'publish an artifact',
      (publisher) => publisher(artifact, caller),
    );
  }
}
