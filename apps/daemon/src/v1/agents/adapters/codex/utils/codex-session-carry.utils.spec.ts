import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { carryCodexSession } from './codex-session-carry.utils';

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, writeFile: vi.fn(original.writeFile) };
});

const SESSION = '01a11c79-5af2-7f63-b61c-225e48718a3f';
const ROLLOUT = `rollout-2026-10-08T21-04-37-${SESSION}.jsonl`;
const HISTORY = `${JSON.stringify({ type: 'session_meta', payload: { id: SESSION } })}\n${JSON.stringify({ type: 'response_item', payload: { role: 'user', content: 'Remember PLUM' } })}\n`;
const CONTINUATION = `${JSON.stringify({ type: 'response_item', payload: { role: 'assistant', content: 'PLUM' } })}\n`;

function homes(store = 'sessions/2026/10/08'): {
  sessionId: string;
  sourcePath: string;
  fromHome: string;
  toHome: string;
  targetPath: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'codex-carry-test-'));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const fromHome = join(root, 'from');
  const toHome = join(root, 'to');
  const sourcePath = join(fromHome, store, ROLLOUT);
  const targetPath = join(toHome, store, ROLLOUT);
  mkdirSync(dirname(sourcePath), { recursive: true });
  mkdirSync(toHome);
  writeFileSync(sourcePath, HISTORY);
  return { sessionId: SESSION, sourcePath, fromHome, toHome, targetPath };
}

describe('carryCodexSession', () => {
  it.each(['sessions/2026/10/08', 'archived_sessions'])(
    'copies the complete rollout in %s and leaves the source and credentials intact',
    async (store) => {
      const input = homes(store);
      writeFileSync(join(input.fromHome, 'auth.json'), 'source credentials');
      writeFileSync(join(input.toHome, 'auth.json'), 'target credentials');

      expect(await carryCodexSession(input)).toEqual({ carried: true });
      expect(readFileSync(input.targetPath, 'utf8')).toBe(HISTORY);
      expect(readFileSync(input.sourcePath, 'utf8')).toBe(HISTORY);
      expect(readFileSync(join(input.toHome, 'auth.json'), 'utf8')).toBe(
        'target credentials',
      );
    },
  );

  it('brings later turns back when switching to a home holding an older prefix', async () => {
    const input = homes();
    await carryCodexSession(input);
    writeFileSync(input.targetPath, HISTORY + CONTINUATION);

    expect(
      await carryCodexSession({
        sessionId: SESSION,
        sourcePath: input.targetPath,
        fromHome: input.toHome,
        toHome: input.fromHome,
      }),
    ).toEqual({ carried: true });
    expect(readFileSync(input.sourcePath, 'utf8')).toBe(HISTORY + CONTINUATION);
    expect(readdirSync(dirname(input.sourcePath))).toEqual([ROLLOUT]);
  });

  it('keeps a newer target continuation when the source holds an older prefix', async () => {
    const input = homes();
    await carryCodexSession(input);
    writeFileSync(input.targetPath, HISTORY + CONTINUATION);

    expect(await carryCodexSession(input)).toEqual({ carried: true });
    expect(readFileSync(input.targetPath, 'utf8')).toBe(HISTORY + CONTINUATION);
  });

  it('keeps both files when their histories have diverged', async () => {
    const input = homes();
    await carryCodexSession(input);
    writeFileSync(input.sourcePath, HISTORY + CONTINUATION);
    writeFileSync(input.targetPath, HISTORY + 'another continuation\n');

    expect(await carryCodexSession(input)).toMatchObject({
      carried: false,
      reason: expect.stringContaining('different continuations'),
    });
    expect(readFileSync(input.sourcePath, 'utf8')).toBe(HISTORY + CONTINUATION);
    expect(readFileSync(input.targetPath, 'utf8')).toBe(
      HISTORY + 'another continuation\n',
    );
  });

  it('refuses a path outside the previous home’s rollout store', async () => {
    const input = homes();
    const outside = join(input.fromHome, ROLLOUT);
    writeFileSync(outside, HISTORY);

    expect(
      await carryCodexSession({ ...input, sourcePath: outside }),
    ).toMatchObject({ carried: false });
    expect(existsSync(input.targetPath)).toBe(false);
  });

  it('refuses a rollout whose filename belongs to another thread', async () => {
    const input = homes();
    expect(
      await carryCodexSession({ ...input, sessionId: 'another-thread' }),
    ).toMatchObject({ carried: false });
    expect(existsSync(input.targetPath)).toBe(false);
  });

  it('reports a missing source and does not copy anything', async () => {
    const input = homes();
    rmSync(input.sourcePath);

    expect(await carryCodexSession(input)).toMatchObject({ carried: false });
    expect(existsSync(input.targetPath)).toBe(false);
  });

  it('accepts a home alias that resolves to the same store', async () => {
    const input = homes();
    const alias = `${input.fromHome}-alias`;
    symlinkSync(input.fromHome, alias);

    expect(await carryCodexSession({ ...input, toHome: alias })).toEqual({
      carried: true,
    });
    expect(readFileSync(input.sourcePath, 'utf8')).toBe(HISTORY);
  });

  it('refuses a target rollout symlink without changing its destination', async () => {
    const input = homes();
    mkdirSync(dirname(input.targetPath), { recursive: true });
    const outside = join(input.toHome, 'unrelated.jsonl');
    writeFileSync(outside, 'unrelated history');
    symlinkSync(outside, input.targetPath);

    expect(await carryCodexSession(input)).toMatchObject({ carried: false });
    expect(readFileSync(outside, 'utf8')).toBe('unrelated history');
  });

  it('refuses a session-store symlink pointing outside the selected home', async () => {
    const input = homes('sessions');
    symlinkSync(dirname(input.sourcePath), join(input.toHome, 'sessions'));

    expect(await carryCodexSession(input)).toMatchObject({ carried: false });
    expect(readFileSync(input.sourcePath, 'utf8')).toBe(HISTORY);
  });

  it('keeps a target changed during the copy and removes the temporary rollout', async () => {
    const input = homes();
    await carryCodexSession(input);
    writeFileSync(input.sourcePath, HISTORY + CONTINUATION);
    const { writeFile: write } =
      await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises',
      );
    vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
      await write(...args);
      writeFileSync(input.targetPath, HISTORY + 'a concurrent turn\n');
    });
    onTestFinished(() => {
      vi.restoreAllMocks();
    });

    expect(await carryCodexSession(input)).toMatchObject({
      carried: false,
      reason: expect.stringContaining('changed'),
    });
    expect(readFileSync(input.targetPath, 'utf8')).toBe(
      HISTORY + 'a concurrent turn\n',
    );
    expect(readdirSync(dirname(input.targetPath))).toEqual([ROLLOUT]);
  });
});
