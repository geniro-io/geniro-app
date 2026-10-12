import * as fs from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { tempDir } from '../../../__tests__/temp-dir';
import {
  sweepStaleTurnSystemPrompts,
  writeTurnSystemPrompt,
} from './claude-system-prompt.utils';

vi.mock('node:fs', { spy: true });
const realFs = await vi.importActual<typeof fs>('node:fs');

afterEach(() => vi.clearAllMocks());

describe('Claude system prompt files', () => {
  it('writes the exact UTF-8 content in a private file and directory', () => {
    const dir = join(tempDir('claude-instructions-'), 'private');
    const prompt = 'Instructions: café, 你好\nsecond line';
    const first = writeTurnSystemPrompt(dir, prompt);
    const second = writeTurnSystemPrompt(dir, prompt);

    expect(fs.readFileSync(first, 'utf8')).toBe(prompt);
    expect(fs.statSync(first).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(first).not.toBe(second);
  });

  it('removes a partial file when writing fails before handing back its path', () => {
    const dir = tempDir('claude-instructions-');
    vi.mocked(fs.writeFileSync).mockImplementationOnce((file) => {
      realFs.writeFileSync(file, 'partial');
      throw new Error('ENOSPC');
    });

    expect(() => writeTurnSystemPrompt(dir, 'instructions')).toThrow('ENOSPC');
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('preserves the write error when removing a partial file also fails', () => {
    const dir = tempDir('claude-instructions-');
    vi.mocked(fs.writeFileSync).mockImplementationOnce((file) => {
      realFs.writeFileSync(file, 'partial');
      throw new Error('ENOSPC');
    });
    vi.mocked(fs.rmSync).mockImplementationOnce(() => {
      throw new Error('EACCES');
    });

    expect(() => writeTurnSystemPrompt(dir, 'instructions')).toThrow('ENOSPC');
    expect(fs.readdirSync(dir)).toHaveLength(1);
    sweepStaleTurnSystemPrompts(dir);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('sweeps crashed prompt files and preserves other files', () => {
    const dir = tempDir('claude-instructions-');
    const stale = writeTurnSystemPrompt(dir, 'instructions');
    const bystanders = [
      'notes.txt',
      'system-prompt-keep.json',
      'mcp-live.json',
    ];
    for (const name of bystanders) {
      fs.writeFileSync(join(dir, name), '{}');
    }

    sweepStaleTurnSystemPrompts(dir);

    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.readdirSync(dir).sort()).toEqual(bystanders.sort());
  });

  it('does not block boot when its directory does not exist', () => {
    expect(() =>
      sweepStaleTurnSystemPrompts(
        join(tempDir('claude-instructions-'), 'missing'),
      ),
    ).not.toThrow();
  });
});
