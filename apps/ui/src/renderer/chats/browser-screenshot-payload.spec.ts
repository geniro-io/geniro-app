import { describe, expect, it } from 'vitest';

import {
  readBrowserScreenshot,
  savedScreenshotPath,
} from './browser-screenshot-payload';
import type { ToolPair } from './transcript-groups';

function pair(input: unknown, result: unknown | null): ToolPair {
  const row = (payload: unknown): ToolPair['call'] =>
    ({ id: 'row', payload }) as ToolPair['call'];
  return {
    call: row({ id: 'c1', name: 'browser_screenshot', input }),
    result: result === null ? null : row({ id: 'c1', ...(result as object) }),
  };
}

describe('readBrowserScreenshot', () => {
  it('reads the saved path out of the result text', () => {
    const read = readBrowserScreenshot(
      pair(
        { tab: 't2' },
        {
          result: [
            {
              type: 'text',
              text: 'Screenshot of t2\nSaved screenshot: /Users/a b/attachments/r1/shot.png',
            },
          ],
          isError: false,
        },
      ),
    );
    expect(read).toEqual({
      tab: 't2',
      path: '/Users/a b/attachments/r1/shot.png',
      note: null,
      failed: false,
    });
  });

  it('has no path while the call is still running', () => {
    expect(readBrowserScreenshot(pair({ tab: 't1' }, null))).toEqual({
      tab: 't1',
      path: null,
      note: null,
      failed: false,
    });
  });

  it('carries a refusal as the note, with no path', () => {
    const read = readBrowserScreenshot(
      pair(
        { tab: 't1' },
        { result: 'The browser did not answer within 20 s.', isError: true },
      ),
    );
    expect(read.path).toBeNull();
    expect(read.failed).toBe(true);
    expect(read.note).toBe('The browser did not answer within 20 s.');
  });

  it('keeps a result without the line as a note rather than a path', () => {
    const read = readBrowserScreenshot(
      pair({}, { result: 'Tab t1 is blank', isError: false }),
    );
    expect(read).toMatchObject({
      tab: null,
      path: null,
      note: 'Tab t1 is blank',
    });
  });
});

describe('savedScreenshotPath', () => {
  it('wants an absolute path', () => {
    expect(savedScreenshotPath('Saved screenshot: shot.png')).toBeNull();
    expect(savedScreenshotPath('Saved screenshot: /tmp/x.png')).toBe(
      '/tmp/x.png',
    );
  });
});
