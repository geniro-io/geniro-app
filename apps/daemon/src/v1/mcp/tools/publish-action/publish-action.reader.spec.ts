import { describe, expect, it } from 'vitest';

import {
  publishActionResultText,
  readPublishAction,
} from './publish-action.reader';

describe('readPublishAction', () => {
  it('maps the wire names onto the publish input', () => {
    expect(
      readPublishAction({
        label: 'PR merged',
        description: 'when it lands',
        action_id: 'merged',
        once: false,
        message: 'continue',
      }),
    ).toEqual({
      label: 'PR merged',
      description: 'when it lands',
      actionId: 'merged',
      once: false,
      message: 'continue',
    });
  });

  it('reads a null optional argument as absent', () => {
    expect(
      readPublishAction({ label: 'x', message: 'y', description: null }),
    ).toEqual({ label: 'x', message: 'y' });
  });

  it('passes stop and command through whatever their shape', () => {
    expect(readPublishAction({ label: 'x', stop: { pid: 1 } })).toEqual({
      label: 'x',
      stop: { pid: 1 },
    });
  });

  it('refuses an unknown argument and a missing label', () => {
    expect(readPublishAction({ label: 'x', mesage: 'typo' })).toEqual({
      error: expect.stringContaining('mesage') as string,
    });
    expect(readPublishAction({ message: 'y' })).toEqual({
      error: expect.stringContaining('label') as string,
    });
  });
});

describe('publishActionResultText', () => {
  it('words an unavailable channel and passes a receipt through', () => {
    expect(
      publishActionResultText({
        status: 'unavailable',
        reason: 'no turn is running',
      }),
    ).toBe('Not published: no turn is running.');
    expect(
      publishActionResultText({ status: 'published', text: 'Published.' }),
    ).toBe('Published.');
  });
});
