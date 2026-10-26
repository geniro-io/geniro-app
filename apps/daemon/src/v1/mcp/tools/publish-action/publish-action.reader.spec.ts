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

  it('reads a stop by shell or pid and refuses any other shape', () => {
    expect(readPublishAction({ label: 'x', stop: { pid: 1 } })).toEqual({
      label: 'x',
      stop: { pid: 1 },
    });
    expect(readPublishAction({ label: 'x', stop: { shell: ' bg1 ' } })).toEqual(
      {
        label: 'x',
        stop: { shell: 'bg1' },
      },
    );
    for (const stop of [
      { pid: -3 },
      { pid: 1.5 },
      { shell: '' },
      { name: 'x' },
      'bg1',
    ]) {
      expect(readPublishAction({ label: 'x', stop })).toEqual({
        error: expect.stringContaining('stop') as string,
      });
    }
  });

  it('reads a command, its snake_case names mapped', () => {
    expect(
      readPublishAction({
        label: 'x',
        command: {
          argv: ['git', 'status'],
          cwd: '/repo',
          timeout_minutes: 5,
          notify_agent: true,
        },
      }),
    ).toEqual({
      label: 'x',
      command: {
        argv: ['git', 'status'],
        cwd: '/repo',
        timeoutMinutes: 5,
        notifyAgent: true,
      },
    });
  });

  it('refuses a command given as a shell line or with a misspelt name', () => {
    expect(readPublishAction({ label: 'x', command: 'ls -la' })).toEqual({
      error: expect.stringContaining('command') as string,
    });
    expect(
      readPublishAction({ label: 'x', command: { argv: ['ls'], timeout: 5 } }),
    ).toEqual({ error: expect.stringContaining('timeout') as string });
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
