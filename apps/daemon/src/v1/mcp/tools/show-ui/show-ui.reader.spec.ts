import { describe, expect, it } from 'vitest';

import { hostUiResultText, readHostUi } from './show-ui.reader';

describe('readHostUi', () => {
  it('reads no call when there are no messages', () => {
    expect(readHostUi({})).toBeNull();
    expect(readHostUi({ messages: [] })).toBeNull();
    expect(readHostUi({ messages: '   ' })).toBeNull();
  });

  it('keeps messages sent as a JSON string as they were sent', () => {
    const messages = '[{"version":"1.0","deleteSurface":{"surfaceId":"plan"}}]';
    expect(readHostUi({ title: 'Plan', messages })).toEqual({
      title: 'Plan',
      messages,
    });
  });

  it('reads the title, and answers null for one that is not text', () => {
    const messages = [{ version: '1.0', deleteSurface: { surfaceId: 'plan' } }];
    expect(readHostUi({ title: 'Plan', messages })?.title).toBe('Plan');
    expect(readHostUi({ title: 7, messages })?.title).toBeNull();
    expect(readHostUi({ messages })?.title).toBeNull();
  });
});

describe('hostUiResultText', () => {
  it('receipts a shown card by its id, version and size, and repeats none of its contents', () => {
    expect(
      hostUiResultText({
        status: 'shown',
        surfaceId: 'plan',
        version: 2,
        op: 'update',
        components: 3,
        media: 0,
      }),
    ).toBe(
      'Shown: surface plan v2 (3 components). Do not repeat its contents in your reply. A press reaches you as a user message.',
    );
  });

  it('counts stored media files in the receipt, singular and plural', () => {
    const shown = {
      status: 'shown' as const,
      surfaceId: 'plan',
      version: 1,
      op: 'create' as const,
      components: 1,
    };
    expect(hostUiResultText({ ...shown, media: 1 })).toContain(
      '(1 component, 1 media file stored)',
    );
    expect(hostUiResultText({ ...shown, media: 2 })).toContain(
      '(1 component, 2 media files stored)',
    );
  });

  it('receipts a removed card', () => {
    expect(
      hostUiResultText({
        status: 'shown',
        surfaceId: 'plan',
        version: 3,
        op: 'remove',
        components: 0,
        media: 0,
      }),
    ).toBe('Removed: surface plan.');
  });

  it('tells the agent to answer in its reply when the card could not be shown', () => {
    expect(
      hostUiResultText({
        status: 'unavailable',
        reason: 'the card could not be saved',
      }),
    ).toBe(
      'The card could not be shown (the card could not be saved). Say it in your reply instead.',
    );
  });
});
