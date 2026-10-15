import { MAX_ARTIFACT_HTML_BYTES } from '../../../agents/chat.types';

/**
 * `show_artifact`'s arguments. `share` is listed only while the user lets
 * agents share pages, so an agent is never offered a switch that refuses.
 */
export function showArtifactSchema(
  shareOffered: boolean,
): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description:
          'What the page IS, as its heading and its row in the panel — e.g. "Migration plan". Keep it short.',
      },
      html: {
        type: 'string',
        description:
          'The whole document: inline <style>/<script>, libraries only from the CDN URLs above, and no ' +
          'fetch of any kind. A picture on this machine goes in as its absolute path in <img src>, not as a ' +
          'data: URI. ' +
          `At most ${Math.floor(MAX_ARTIFACT_HTML_BYTES / 1024)}KB of HTML: a picture named by its path adds only ` +
          'the path, and an oversize page is REFUSED rather than cut short, so write a smaller one.',
      },
      artifact_id: {
        type: 'string',
        description:
          'A short lowercase slug naming this page — e.g. "migration-plan". Pass the SAME one again to ' +
          'revise that page in place; omit it for a page that has nothing to revise.',
      },
      summary: {
        type: 'string',
        description:
          'One line under the title in the panel. Optional — leave it out when the title already says it.',
      },
      ...(shareOffered
        ? {
            share: {
              type: 'boolean',
              description:
                'true to ALSO upload this page as an end-to-end-encrypted link anyone holding it can open. ' +
                'Only when the user or your instructions ask for the page to be shared. Passing it again ' +
                'when you revise a shared page updates what its link shows; the link stays the same.',
            },
          }
        : {}),
    },
    required: ['title', 'html'],
  };
}
