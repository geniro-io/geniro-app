import { describe, expect, it } from 'vitest';

import { MAX_ATTACHMENTS_PER_MESSAGE } from '../../agents/chat.types';
import { runWorkflowSchema } from './workflows.dto';

const IMAGE = { mediaType: 'image/png', data: 'aGk=' } as const;

describe('runWorkflowSchema', () => {
  it('starts a run from pasted images alone, as a chat message may', () => {
    expect(
      runWorkflowSchema.safeParse({ cwd: '/w', prompt: '', images: [IMAGE] })
        .success,
    ).toBe(true);
  });

  it('refuses a start carrying neither a task nor an image', () => {
    expect(
      runWorkflowSchema.safeParse({ cwd: '/w', prompt: '   ' }).success,
    ).toBe(false);
  });

  it('refuses more images than one message may carry, or a type it may not', () => {
    expect(
      runWorkflowSchema.safeParse({
        cwd: '/w',
        prompt: 'go',
        images: Array.from(
          { length: MAX_ATTACHMENTS_PER_MESSAGE + 1 },
          () => IMAGE,
        ),
      }).success,
    ).toBe(false);
    expect(
      runWorkflowSchema.safeParse({
        cwd: '/w',
        prompt: 'go',
        images: [{ mediaType: 'application/pdf', data: 'aGk=' }],
      }).success,
    ).toBe(false);
  });
});
