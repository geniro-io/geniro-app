import { describe, expect, it } from 'vitest';

import {
  errorSignature,
  type FailedCall,
  FAILURE_GROUP_EXAMPLES,
  groupFailures,
} from './failure-groups';

function call(
  runId: string,
  seq: number,
  tool: string,
  error: string,
  at = '2026-11-20T10:00:00.000Z',
): FailedCall {
  return { runId, seq, resultSeq: seq + 1, at, tool, error };
}

describe('errorSignature', () => {
  it('masks what differs between two calls failing for one reason', () => {
    expect(
      errorSignature(
        'File does not exist. Note: your current working directory is /Users/a/b. Read "x.ts" at line 12',
      ),
    ).toBe(
      errorSignature(
        'File does not exist. Note: your current working directory is /tmp/c. Read "y.ts" at line 3',
      ),
    );
    expect(errorSignature('Exit code 1\nnpm ERR! missing script')).toBe(
      'Exit code #',
    );
  });

  it("reads a JSON error body's message, and the first line that says anything", () => {
    expect(
      errorSignature(
        JSON.stringify({ error: 'INVALID_ARGS', message: 'ids is required' }),
      ),
    ).toBe('INVALID_ARGS');
    expect(
      errorSignature(
        '<tool_use_error>\n\nString to replace not found in file.',
      ),
    ).toBe('String to replace not found in file.');
  });

  it('keeps two different reasons apart', () => {
    expect(errorSignature('File does not exist.')).not.toBe(
      errorSignature('File has not been read yet.'),
    );
  });
});

describe('groupFailures', () => {
  it('counts every call of a group, largest group first, and caps only the examples, taken from different threads first', () => {
    const calls = [
      call('r1', 1, 'Bash', 'Exit code 1\nboom'),
      call('r1', 3, 'Bash', 'Exit code 2\nbang'),
      call('r1', 5, 'Bash', 'Exit code 1\nboom'),
      call('r1', 7, 'Bash', 'Exit code 1\nboom'),
      call('r2', 2, 'Bash', 'Exit code 127', '2026-11-19T10:00:00.000Z'),
      call('r3', 4, 'Bash', 'Exit code 1', '2026-11-21T10:00:00.000Z'),
      call('r2', 6, 'memory_read', 'INVALID_ARGS: ids is required'),
    ];

    const groups = groupFailures(calls, 300);

    expect(
      groups.map((group) => [
        group.tool,
        group.signature,
        group.count,
        group.threads,
      ]),
    ).toEqual([
      ['Bash', 'Exit code #', 6, 3],
      ['memory_read', 'INVALID_ARGS: ids is required', 1, 1],
    ]);
    expect(groups[0]!.examples).toHaveLength(FAILURE_GROUP_EXAMPLES);
    expect(groups[0]!.examples.map((example) => example.runId)).toEqual([
      'r1',
      'r2',
      'r3',
    ]);
    expect(groups[0]).toMatchObject({
      firstAt: '2026-11-19T10:00:00.000Z',
      lastAt: '2026-11-21T10:00:00.000Z',
    });
  });

  it("clips a group's error text and names the row that holds it whole", () => {
    const [group] = groupFailures(
      [call('r1', 8, 'Bash', `Exit code 1 ${'z'.repeat(50)}`)],
      20,
    );

    expect(group!.error).toBe(
      `Exit code 1 ${'z'.repeat(8)}… [view=item runId=r1 seq=9]`,
    );
  });
});
