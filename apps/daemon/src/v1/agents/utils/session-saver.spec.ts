import { describe, expect, it, vi } from 'vitest';

import type { NodeStateDao } from '../dao/node-state.dao';
import { createSessionIdSaver } from './session-saver';

function dao(): { saveSessionId: ReturnType<typeof vi.fn> } {
  return { saveSessionId: vi.fn().mockResolvedValue(undefined) };
}

describe('createSessionIdSaver', () => {
  it('persists only when the session id actually changes', async () => {
    const fake = dao();
    const save = createSessionIdSaver(
      fake as unknown as NodeStateDao,
      'run-1',
      'node-a',
      null,
    );

    await save('sess-1');
    await save('sess-1');
    await save('sess-1');
    await save('sess-2');

    expect(fake.saveSessionId).toHaveBeenCalledTimes(2);
    expect(fake.saveSessionId).toHaveBeenNthCalledWith(
      1,
      'run-1',
      'node-a',
      'sess-1',
      undefined,
    );
    expect(fake.saveSessionId).toHaveBeenNthCalledWith(
      2,
      'run-1',
      'node-a',
      'sess-2',
      undefined,
    );
  });

  it('skips the resume id it was seeded with (already persisted last turn)', async () => {
    const fake = dao();
    const save = createSessionIdSaver(
      fake as unknown as NodeStateDao,
      'run-1',
      'node-a',
      'sess-resume',
    );

    await save('sess-resume');

    expect(fake.saveSessionId).not.toHaveBeenCalled();
  });
});
