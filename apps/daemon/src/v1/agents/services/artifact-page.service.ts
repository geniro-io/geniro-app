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
}
