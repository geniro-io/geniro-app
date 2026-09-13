import { describe, expect, it } from 'vitest';

import { type ShellRow, strandedShells } from './open-shells';

const open = (
  id: string | null,
  workId: string,
  extra: Record<string, unknown> = {},
  nodeId: string | null = null,
): ShellRow => ({
  kind: 'shell_open',
  payload: JSON.stringify({ id, workId, ...extra }),
  nodeId,
});
const close = (id: string | null, workId: string): ShellRow => ({
  kind: 'shell_info',
  payload: JSON.stringify({ id, workId }),
  nodeId: null,
});

describe('strandedShells', () => {
  it('answers the commands opened and never closed', () => {
    expect(
      strandedShells([
        open('t1', 'b1'),
        open('t2', 'b2'),
        close('t2', 'b2'),
      ]).map((shell) => shell.workId),
    ).toEqual(['b1']);
  });

  it('matches a close by its launching call when it names one', () => {
    // The call is the stronger key: a close naming it is about that shell
    // whatever work id it carries alongside.
    expect(strandedShells([open('t1', 'b1'), close('t1', 'other')])).toEqual(
      [],
    );
  });

  it('matches a close by the work id when it names no call', () => {
    expect(strandedShells([open('t1', 'b1'), close(null, 'b1')])).toEqual([]);
  });

  it('keeps where the open row was filed, so the close can be filed there too', () => {
    expect(
      strandedShells([open('t1', 'b1', { callId: 'call-2' }, 'engineer')]),
    ).toEqual([
      { toolCallId: 't1', workId: 'b1', nodeId: 'engineer', callId: 'call-2' },
    ]);
  });

  it('skips a row it cannot read rather than throwing', () => {
    expect(
      strandedShells([
        { kind: 'shell_open', payload: 'not json', nodeId: null },
        open('t1', 'b1'),
      ]).map((shell) => shell.workId),
    ).toEqual(['b1']);
  });
});
