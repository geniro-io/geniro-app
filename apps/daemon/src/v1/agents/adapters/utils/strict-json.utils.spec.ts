import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readConfigForRewrite } from './strict-json.utils';

const dirs: string[] = [];

function file(content?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'strict-json-'));
  dirs.push(dir);
  const path = join(dir, 'config.json');
  if (content !== undefined) {
    writeFileSync(path, content);
  }
  return path;
}

afterEach(() => {
  while (dirs.length > 0) {
    rmSync(dirs.pop() as string, { recursive: true, force: true });
  }
});

describe('readConfigForRewrite', () => {
  it('reads an object, and a missing file as an empty one', async () => {
    await expect(readConfigForRewrite(file('{"a":1}'))).resolves.toEqual({
      ok: true,
      config: { a: 1 },
    });
    await expect(readConfigForRewrite(file())).resolves.toEqual({
      ok: true,
      config: {},
    });
  });

  it('refuses a file it cannot parse, or one that is not an object', async () => {
    for (const [content, reason] of [
      ['{ broken', 'is not valid JSON'],
      ['[]', 'is not a JSON object'],
      ['null', 'is not a JSON object'],
    ] as const) {
      const result = await readConfigForRewrite(file(content));
      expect(result.ok ? null : result.reason).toContain(reason);
    }
  });

  it('refuses a file it cannot read, rather than reading it as empty', async () => {
    const path = file('{}');
    chmodSync(path, 0);
    const result = await readConfigForRewrite(path);
    expect(result.ok ? null : result.reason).toContain(
      'could not be read (EACCES)',
    );
  });
});
