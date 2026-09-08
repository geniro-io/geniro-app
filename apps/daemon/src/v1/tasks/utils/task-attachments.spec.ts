import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { removeTaskAttachments } from './task-attachments';

describe('removeTaskAttachments', () => {
  /** The throwaway tree. Everything this spec can reach stays inside it. */
  let sandbox: string;
  let root: string;

  beforeAll(() => {
    // The root is nested TWO levels inside the sandbox on purpose: one test
    // hands `removeTaskAttachments` a `../..` id, and if the shape guard it
    // pins ever regresses that path is what gets recursively removed. Nested,
    // `../..` resolves to the sandbox; rooted at `mkdtemp` itself it would
    // resolve to the OS temp PARENT and take every other suite's fixtures
    // with it — a test whose failure mode is a side effect rather than a red
    // assertion.
    sandbox = mkdtempSync(join(tmpdir(), 'geniro-attach-'));
    root = join(sandbox, 'store', 'attachments');
    mkdirSync(root, { recursive: true });
  });

  afterAll(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  const seed = (taskId: string): string => {
    const dir = join(root, taskId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'shot.png'), 'bytes');
    return dir;
  };

  it('drops the card’s whole directory', async () => {
    const taskId = randomUUID();
    const dir = seed(taskId);

    await removeTaskAttachments(taskId, root);

    expect(existsSync(dir)).toBe(false);
  });

  it('leaves every OTHER card alone', async () => {
    const doomed = randomUUID();
    const kept = randomUUID();
    seed(doomed);
    const keptDir = seed(kept);

    await removeTaskAttachments(doomed, root);

    expect(existsSync(keptDir)).toBe(true);
  });

  it('refuses an id that is not one this module mints', async () => {
    // The safety bound, and the whole reason the shape is checked before the
    // join: this is the module's one recursive delete, and the id reaches it
    // from a route param. Without the guard `..` names the root's parent.
    const outside = join(root, 'not-a-uuid');
    mkdirSync(outside, { recursive: true });

    await removeTaskAttachments('not-a-uuid', root);
    await removeTaskAttachments('../..', root);

    expect(existsSync(outside)).toBe(true);
    expect(existsSync(root)).toBe(true);
  });

  it('is a no-op for a card that pasted nothing', async () => {
    await expect(
      removeTaskAttachments(randomUUID(), root),
    ).resolves.toBeUndefined();
  });
});
