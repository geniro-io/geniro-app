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
                "The file's FULL path on disk. A relative one is measured against this conversation's own working directory, which is frequently not the directory you wrote the file in.",
            },
            caption: {
              type: 'string',
              description:
                'What THIS picture shows. Optional — leave it out when the pictures speak for ' +
                'themselves, rather than captioning every tile to fill the field.',
            },
          },
          required: ['path'],
        },
      },
    },
    required: ['images'],
  };
}
