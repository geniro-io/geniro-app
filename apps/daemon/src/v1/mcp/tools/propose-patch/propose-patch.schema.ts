/** `propose_patch`'s arguments. */
export function proposePatchSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description:
          'The file to change, relative to the working folder. It must be inside that folder.',
      },
      old_string: {
        type: 'string',
        description:
          'The exact text to replace. It must appear EXACTLY ONCE in the file — include enough surrounding ' +
          'lines to make it unique, or the patch is refused rather than applied to a guess. Omit this ' +
          'field entirely to write the whole file (a new file, or a deliberate full rewrite).',
      },
      new_string: {
        type: 'string',
        description:
          'The replacement text. Use an empty string to delete the matched text.',
      },
      summary: {
        type: 'string',
        description:
          'One line saying what the change does, shown as the card\'s heading — e.g. "Raise the queue timeout to 60s".',
      },
    },
    required: ['file_path', 'new_string', 'summary'],
  };
}
