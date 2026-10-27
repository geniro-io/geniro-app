import { MAX_GALLERY_IMAGES } from '../../../agents/chat.types';

/** `show_gallery`'s arguments. */
export function showGallerySchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description:
          'What the set is, as the card\'s heading — e.g. "Composer, before and after". Optional.',
      },
      images: {
        type: 'array',
        description: `The pictures, in the order they should be shown — at most ${MAX_GALLERY_IMAGES}.`,
        items: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description:
                "The file's FULL path on disk, or an http(s) URL of a picture on the web, which this app " +
                "downloads when you call the tool. A relative path is measured against this conversation's " +
                'own working directory, which is frequently not the directory you wrote the file in.',
            },
            caption: {
              type: 'string',
              description:
                'A short heading for THIS picture — what it is. Optional — leave it out when the pictures ' +
                'speak for themselves, rather than captioning every tile to fill the field.',
            },
            description: {
              type: 'string',
              description:
                'Longer text shown under the caption — the details a reader needs about this picture ' +
                '(price, contents, what changed). Optional; line breaks are kept.',
            },
          },
          required: ['path'],
        },
      },
    },
    required: ['images'],
  };
}
