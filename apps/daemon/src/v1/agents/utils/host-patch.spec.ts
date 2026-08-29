import { describe, expect, it } from 'vitest';

import {
  HOST_PATCH_TOOL,
  MAX_PATCH_SUMMARY_LENGTH,
  MAX_PATCH_TEXT_LENGTH,
} from '../chat.types';
import {
  hostPatchResultText,
  isHostPatchCall,
  readHostPatch,
} from './host-patch';

const SERVER = 'geniro-1a2b3c4d';

describe('isHostPatchCall', () => {
  it('matches both CLIs’ spellings of this run’s server', () => {
    expect(isHostPatchCall(SERVER, `mcp__${SERVER}__${HOST_PATCH_TOOL}`)).toBe(
      true,
    );
    expect(isHostPatchCall(SERVER, `${SERVER}: ${HOST_PATCH_TOOL}`)).toBe(true);
  });

  it('refuses somebody else’s tool of the same name', () => {
    expect(isHostPatchCall(SERVER, 'mcp__acme__propose_patch')).toBe(false);
    expect(isHostPatchCall(null, `mcp__${SERVER}__${HOST_PATCH_TOOL}`)).toBe(
      false,
    );
  });
});

describe('readHostPatch', () => {
  it('reads an edit, crossing the snake_case seam', () => {
    expect(
      readHostPatch({
        file_path: 'src/a.ts',
        old_string: 'const timeout = 30;',
        new_string: 'const timeout = 60;',
        summary: 'Raise the queue timeout to 60s',
      }),
    ).toEqual({
      ok: true,
      patch: {
        filePath: 'src/a.ts',
        oldString: 'const timeout = 30;',
        newString: 'const timeout = 60;',
        summary: 'Raise the queue timeout to 60s',
      },
    });
  });

  it('reads a whole-file write — no old_string at all', () => {
    const read = readHostPatch({
      file_path: 'src/new.ts',
      new_string: 'export const x = 1;\n',
    });
    expect(read.ok).toBe(true);
    expect(read.ok && read.patch).not.toHaveProperty('oldString');
  });

  it('ACCEPTS an empty new_string — that is how a block is deleted', () => {
    // The reason the check is `typeof`, not truthiness. A `!newString` guard
    // would refuse the one edit that removes code.
    const read = readHostPatch({
      file_path: 'src/a.ts',
      old_string: 'debugger;\n',
      new_string: '',
    });
    expect(read.ok).toBe(true);
    expect(read.ok && read.patch.newString).toBe('');
  });

  it.each([
    ['no file_path', { new_string: 'x' }, 'file_path'],
    ['a blank file_path', { file_path: '   ', new_string: 'x' }, 'file_path'],
    ['no new_string', { file_path: 'a.ts' }, 'new_string'],
    [
      'a non-string new_string',
      { file_path: 'a.ts', new_string: 42 },
      'new_string',
    ],
    [
      'a non-string old_string',
      { file_path: 'a.ts', old_string: 7, new_string: 'x' },
      'old_string',
    ],
    [
      'an EMPTY old_string — it matches everywhere, so it names no edit',
      { file_path: 'a.ts', old_string: '', new_string: 'x' },
      'cannot be empty',
    ],
    [
      'a patch that changes nothing',
      { file_path: 'a.ts', old_string: 'same', new_string: 'same' },
      'identical',
    ],
  ])('refuses %s, and says which field', (_name, args, mentions) => {
    const read = readHostPatch(args as Record<string, unknown>);
    expect(read.ok).toBe(false);
    expect(!read.ok && read.reason).toContain(mentions);
  });

  it('REFUSES an over-long body rather than truncating it', () => {
    // The one place this family's usual kindness is wrong: the first N
    // characters of a file body is a truncated file, and writing one is worse
    // than answering "too large".
    const read = readHostPatch({
      file_path: 'a.ts',
      new_string: 'x'.repeat(MAX_PATCH_TEXT_LENGTH + 1),
    });
    expect(read.ok).toBe(false);
    expect(!read.ok && read.reason).toContain('truncated file');
  });

  it('refuses an over-long old_string too', () => {
    const read = readHostPatch({
      file_path: 'a.ts',
      old_string: 'y'.repeat(MAX_PATCH_TEXT_LENGTH + 1),
      new_string: 'z',
    });
    expect(read.ok).toBe(false);
  });

  it('truncates the SUMMARY, which is a caption rather than content', () => {
    const read = readHostPatch({
      file_path: 'a.ts',
      new_string: 'x',
      summary: 's'.repeat(500),
    });
    expect(read.ok && read.patch.summary).toHaveLength(
      MAX_PATCH_SUMMARY_LENGTH,
    );
  });
});

describe('hostPatchResultText', () => {
  it('tells an applied patch not to write the file again', () => {
    const text = hostPatchResultText({ status: 'applied', path: 'src/a.ts' });
    expect(text).toContain('src/a.ts');
    expect(text).toContain('do not write it again');
  });

  it('tells a refusal not to route around the user', () => {
    expect(hostPatchResultText({ status: 'declined' })).toContain(
      'Do not apply it another way',
    );
  });

  it('does NOT read a stale patch as a refusal — the user said yes', () => {
    // The distinction the fourth arm exists for: told "rejected", an agent
    // argues; told "stale", it re-reads the file, which is the right move.
    const text = hostPatchResultText({
      status: 'stale',
      reason: 'the text to replace is no longer in the file',
    });
    expect(text).toContain('accepted');
    expect(text).toContain('Re-read the file');
    expect(text).not.toContain('rejected');
  });

  it('names the reason when the patch never reached the user', () => {
    expect(
      hostPatchResultText({ status: 'unavailable', reason: 'no turn running' }),
    ).toContain('no turn running');
  });
});
