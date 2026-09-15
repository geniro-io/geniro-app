import { describe, expect, it } from 'vitest';

import { MAX_NOTIFY_MESSAGE_LENGTH } from '../chat.types';
import { hostNotifyResultText, readHostNotify } from './host-notify';

describe('readHostNotify', () => {
  it('reads the message, trimmed', () => {
    expect(readHostNotify({ message: '  Ready at :3000.  ' })).toBe(
      'Ready at :3000.',
    );
  });

  it('caps a long message rather than refusing it', () => {
    const read = readHostNotify({ message: 'x'.repeat(2000) });
    expect(read).toHaveLength(MAX_NOTIFY_MESSAGE_LENGTH);
  });

  it.each([
    ['a blank message', { message: '   ' }],
    ['a non-string message', { message: 42 }],
    ['no message at all', {}],
    ['no arguments', undefined],
    ['an array', ['Ready']],
  ])('refuses %s', (_label, args) => {
    expect(readHostNotify(args)).toBeNull();
  });
});

describe('hostNotifyResultText', () => {
  it('answers a sent notification with a receipt that asks for no repeat', () => {
    expect(hostNotifyResultText({ status: 'sent' })).toBe(
      'Notification sent to the user. Do not send another for the same thing.',
    );
  });

  it('tells the agent to say it in its reply when nothing could send it', () => {
    expect(
      hostNotifyResultText({ status: 'unavailable', reason: 'no turn' }),
    ).toContain('Say it in your reply instead');
  });
});
