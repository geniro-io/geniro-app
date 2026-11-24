import {
  MAX_UI_COMPONENTS,
  MAX_UI_MESSAGES,
  MAX_UI_TITLE_LENGTH,
} from '../../../agents/chat.types';

export function showUiSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: `The card's heading, e.g. "Release settings". At most ${MAX_UI_TITLE_LENGTH} characters. Optional.`,
      },
      messages: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_UI_MESSAGES,
        description: `A2UI v1.0 messages for ONE surfaceId, applied in order: createSurface, updateComponents, updateDataModel, deleteSurface. Each is {"version":"1.0","<kind>":{…}}. At most ${MAX_UI_COMPONENTS} components per surface.`,
        items: { type: 'object' },
      },
    },
    required: ['messages'],
  };
}
