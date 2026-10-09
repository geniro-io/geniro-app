import { Injectable } from '@nestjs/common';

import {
  renderArtifactDocument,
  renderArtifactPage,
  withInlineImages,
} from '../utils/artifact-page';
import { ArtifactStoreService } from './artifact-store.service';

/**
 * One published artifact as the document that is actually served: the agent's
 * page with geniro's page runtime in front of it and its theme-and-height
 * wrapper appended.
 *
 * Its own service rather than two calls from the controller, on the module
 * rule that a controller makes ONE call into a service — and it earns the
 * seat, because "which page" and "what the page is wrapped in" are the two
 * halves of this route and neither belongs in a route handler.
 */
@Injectable()
export class ArtifactPageService {
  constructor(private readonly store: ArtifactStoreService) {}

  /**
   * The document to serve, or null when the request names nothing this daemon
   * holds or presents the wrong key — ONE null for every failure, inherited
   * from {@link ArtifactStoreService.read}, which says why.
   */
  page(
    runId: string,
    artifactId: string,
    version: number,
    key: string,
  ): string | null {
    const html = this.store.read(runId, artifactId, version, key);
    return html === null
      ? null
      : renderArtifactPage(this.inline(runId, artifactId, key, html));
  }

  /**
   * The page with its stored pictures written into it. Each picture is read
   * under the same key the page was, so the pictures are no more reachable than
   * the page is.
   */
  private inline(
    runId: string,
    artifactId: string,
    key: string,
    html: string,
  ): string {
    return withInlineImages(html, (file) =>
      this.store.readImage(runId, artifactId, key, file),
    );
  }

  /**
   * The agent's stored document without the frame wrapper — what the
   * app saves when the user asks for the page as a file to share.
   *
   * A second reading rather than a flag on {@link page}, because the two answer
   * different questions: that one is "what does this app frame", this one is
   * "what did the agent actually author". The wrapper is geniro's own plumbing
   * — a `postMessage` handshake with an embedder — so a file carrying it would
   * ship this app's internals to whoever the page is sent to, and would sit
   * there listening for a parent that is never going to speak. The page
   * RUNTIME does ride along: the agent's own script calls `geniro.chart`, and
   * a saved page without it would throw on its first line.
   *
   * It is NOT a weaker door. The key is checked by the same
   * {@link ArtifactStoreService.read}, and what comes back is strictly LESS
   * than the framed route already serves.
   */
  document(
    runId: string,
    artifactId: string,
    version: number,
    key: string,
  ): string | null {
    const html = this.store.read(runId, artifactId, version, key);
    return html === null
      ? null
      : renderArtifactDocument(this.inline(runId, artifactId, key, html));
  }
}
