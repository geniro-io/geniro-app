import { Injectable } from '@nestjs/common';

import { renderArtifactPage } from '../utils/artifact-page';
import { ArtifactStoreService } from './artifact-store.service';

/**
 * One published artifact as the document that is actually served: the agent's
 * page with geniro's own theme-and-height wrapper appended.
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
    return html === null ? null : renderArtifactPage(html);
  }

  /**
   * The stored document as the AGENT wrote it, with no wrapper — what the app
   * saves when the user asks for the page as a file to share.
   *
   * A second reading rather than a flag on {@link page}, because the two answer
   * different questions: that one is "what does this app frame", this one is
   * "what did the agent actually author". The wrapper is geniro's own plumbing
   * — a `postMessage` handshake with an embedder — so a file carrying it would
   * ship this app's internals to whoever the page is sent to, and would sit
   * there listening for a parent that is never going to speak.
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
    return this.store.read(runId, artifactId, version, key);
  }
}
