import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readCursorSessionTitle } from './cursor-session-meta.utils';

describe('readCursorSessionTitle', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cursor-meta-spec-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Write a meta.json and answer with its path. */
  const meta = (body: string): string => {
    const path = join(dir, 'meta.json');
    writeFileSync(path, body);
    return path;
  };

  it('reads the agent-generated title out of a real header', () => {
    // Verbatim from geniro's own store, 2026-08-22 (cursor-agent
    // 2026.08.11-e8db854).
    const path = meta(
      '{"schemaVersion":1,"cwd":"/Users/x/example-app","title":"Fix Conflicts Worktree"}',
    );
    expect(readCursorSessionTitle(path)).toBe('Fix Conflicts Worktree');
  });

  it('answers null for a header the agent has not titled yet', () => {
    const path = meta('{"schemaVersion":1,"cwd":"/Users/x/geniro-app"}');
    expect(readCursorSessionTitle(path)).toBeNull();
  });

  it('answers null for a blank title rather than labelling a chat with it', () => {
    const path = meta('{"schemaVersion":1,"title":"   "}');
    expect(readCursorSessionTitle(path)).toBeNull();
  });

  it('answers null, and warns, when the header cannot be parsed', () => {
    const warn = vi.fn();
    const path = meta('{not json');
    expect(readCursorSessionTitle(path, warn)).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });

  it('answers null for a missing file without throwing', () => {
    const warn = vi.fn();
    expect(readCursorSessionTitle(join(dir, 'absent.json'), warn)).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });

  it('refuses a header far larger than any real one', () => {
    const warn = vi.fn();
    const path = meta(`{"title":"${'a'.repeat(300 * 1024)}"}`);

    expect(readCursorSessionTitle(path, warn)).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });

  it('answers null for a body that is valid JSON but not an object', () => {
    expect(readCursorSessionTitle(meta('"just a string"'))).toBeNull();
  });

  it('answers null when title is present but not a string', () => {
    const path = meta('{"schemaVersion":1,"title":42}');
    expect(readCursorSessionTitle(path)).toBeNull();
  });
});
