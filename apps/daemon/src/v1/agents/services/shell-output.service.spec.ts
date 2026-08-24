import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Item } from '../../runs/entity/item.entity';
import { MAX_SHELL_OUTPUT_BYTES } from '../chat.types';
import type { ItemDao } from '../dao/item.dao';
import type { RunDao } from '../dao/run.dao';
import { ShellOutputService } from './shell-output.service';

let dir = '';
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'shell-output-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * One row as the DATABASE holds it — `Item.payload` is JSON TEXT, not an
 * object.
 *
 * Stringified here deliberately: the fixture that passed an object let a
 * service reading `.result` straight off the string pass its whole spec while
 * answering 404 for every command on a real run.
 */
const item = (kind: Item['kind'], payload: unknown): Item =>
  ({ kind, payload: JSON.stringify(payload) }) as Item;

/** A service over a fake run holding exactly one tool call pair. */
function serviceFor(pair: {
  call: Item | null;
  result: Item | null;
}): ShellOutputService {
  const runs = { getById: async () => ({ id: 'r1' }) } as unknown as RunDao;
  const items = { findToolCallPair: async () => pair } as unknown as ItemDao;
  return new ShellOutputService(runs, items);
}

describe('ShellOutputService', () => {
  it('tails the file a DETACHED command is writing', async () => {
    const path = join(dir, 'bg.log');
    writeFileSync(path, 'building…\nReady in 812ms\n');
    const service = serviceFor({
      call: item('tool_call', { id: 'c1', name: 'Bash' }),
      result: item('tool_result', {
        id: 'c1',
        result: `Command running in background with ID: bash_1. Output is being written to: ${path}.`,
      }),
    });

    expect(await service.read('r1', 'c1')).toEqual({
      text: 'building…\nReady in 812ms\n',
      truncated: false,
      unavailableReason: null,
    });
  });

  it('returns the TAIL of a long file, cut at a line boundary', async () => {
    // What a terminal shows. The head of an hour-old dev server's log is not
    // what somebody clicking the row is looking for, and a cut mid-character
    // would decode to replacement glyphs.
    const path = join(dir, 'long.log');
    const line = `${'x'.repeat(99)}\n`;
    const lines = Math.ceil((MAX_SHELL_OUTPUT_BYTES / 100) * 1.5);
    writeFileSync(path, `FIRST\n${line.repeat(lines)}LAST\n`);
    const service = serviceFor({
      call: item('tool_call', { id: 'c1', name: 'Bash' }),
      result: item('tool_result', {
        id: 'c1',
        result: `Output is being written to: ${path}.`,
      }),
    });

    const out = await service.read('r1', 'c1');
    expect(out.truncated).toBe(true);
    expect(out.text).not.toContain('FIRST');
    expect(out.text.endsWith('LAST\n')).toBe(true);
    expect(out.text.startsWith('x')).toBe(true);
    expect(out.text.length).toBeLessThanOrEqual(MAX_SHELL_OUTPUT_BYTES);
  });

  it('answers a FOREGROUND command with the reply it already returned', async () => {
    // One route for both, because the panel's rows do not distinguish them.
    const service = serviceFor({
      call: item('tool_call', { id: 'c1', name: 'Bash' }),
      result: item('tool_result', {
        id: 'c1',
        result: 'total 8\ndrwxr-xr-x\n',
      }),
    });

    expect(await service.read('r1', 'c1')).toEqual({
      text: 'total 8\ndrwxr-xr-x\n',
      truncated: false,
      unavailableReason: null,
    });
  });

  it('says a command still running has produced nothing yet', async () => {
    // An ANSWER, not an error: a foreground command's output arrives with its
    // result, and until then there is genuinely nothing to show.
    const service = serviceFor({
      call: item('tool_call', { id: 'c1', name: 'Bash' }),
      result: null,
    });

    const out = await service.read('r1', 'c1');
    expect(out.text).toBe('');
    expect(out.unavailableReason).toContain('still running');
  });

  it('says so when the output file is gone', async () => {
    const service = serviceFor({
      call: item('tool_call', { id: 'c1', name: 'Bash' }),
      result: item('tool_result', {
        id: 'c1',
        result: `Output is being written to: ${join(dir, 'nope.log')}.`,
      }),
    });

    const out = await service.read('r1', 'c1');
    expect(out.text).toBe('');
    expect(out.unavailableReason).toContain('output file is gone');
  });

  it('refuses a call id that could be a LIKE pattern', async () => {
    // The DAO narrows in SQL with `$like` over the payload text, so a `%` from
    // a caller would match every payload in the run. Both CLIs' ids are opaque
    // tokens, so nothing real is refused.
    const service = serviceFor({ call: null, result: null });

    await expect(service.read('r1', '%')).rejects.toThrow();
    await expect(service.read('r1', '')).rejects.toThrow();
  });

  it('refuses a call this run never made', async () => {
    const service = serviceFor({ call: null, result: null });

    await expect(service.read('r1', 'toolu_nope')).rejects.toThrow();
  });

  it('reads a content-block reply the same way the renderer does', async () => {
    const service = serviceFor({
      call: item('tool_call', { id: 'c1', name: 'Bash' }),
      result: item('tool_result', {
        id: 'c1',
        result: [{ type: 'text', text: 'hello' }],
      }),
    });

    expect((await service.read('r1', 'c1')).text).toBe('hello');
  });
});
