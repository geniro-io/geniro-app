import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MAX_ARTIFACT_HTML_BYTES } from '../chat.types';
import { ArtifactStoreService } from './artifact-store.service';

const RUN = '11111111-2222-4333-8444-555555555555';
const OTHER_RUN = '99999999-8888-4777-8666-555555555555';
const PAGE = '<!doctype html><title>Plan</title><p>step one';

describe('ArtifactStoreService', () => {
  let root: string;
  let store: ArtifactStoreService;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'geniro-artifacts-'));
    store = new ArtifactStoreService({ root });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const publish = (
    artifact: { id?: string; title?: string; html?: string },
    runId = RUN,
  ) =>
    store.publish(runId, {
      title: artifact.title ?? 'Plan',
      html: artifact.html ?? PAGE,
      ...(artifact.id === undefined ? {} : { id: artifact.id }),
    });

  describe('publish', () => {
    it('stores the page and hands back the row the transcript needs', () => {
      const result = publish({ id: 'plan' });
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.stored.artifactId).toBe('plan');
      expect(result.stored.version).toBe(1);
      expect(result.stored.key).toMatch(/^[0-9a-f]{64}$/);
      expect(store.read(RUN, 'plan', 1, result.stored.key)).toBe(PAGE);
    });

    it('mints an id when the agent named none, so nothing is overwritten', () => {
      const first = publish({});
      const second = publish({});
      expect(first.ok && second.ok).toBe(true);
      if (!first.ok || !second.ok) {
        return;
      }
      expect(first.stored.artifactId).not.toBe(second.stored.artifactId);
      expect(first.stored.version).toBe(1);
      expect(second.stored.version).toBe(1);
    });

    it('bumps the version and KEEPS the key when the same id is republished', () => {
      const first = publish({ id: 'plan' });
      const second = publish({ id: 'plan', html: '<p>step two' });
      expect(first.ok && second.ok).toBe(true);
      if (!first.ok || !second.ok) {
        return;
      }
      expect(second.stored.version).toBe(2);
      // A rotated key would silently break every card already in the
      // scrollback, each of which carries the key it was published with.
      expect(second.stored.key).toBe(first.stored.key);
    });

    it('keeps the OLD version readable, so an older card still opens what it announced', () => {
      const first = publish({ id: 'plan' });
      publish({ id: 'plan', html: '<p>step two' });
      expect(first.ok).toBe(true);
      if (!first.ok) {
        return;
      }
      expect(store.read(RUN, 'plan', 1, first.stored.key)).toBe(PAGE);
      expect(store.read(RUN, 'plan', 2, first.stored.key)).toBe('<p>step two');
    });

    it('keeps the newest ten versions and prunes what falls out', () => {
      // The one cap in this family that bounds a LOOP rather than a call: the
      // tool tells agents to republish the same id, so without this a page
      // revised through a session grows the userData directory unbounded.
      let key = '';
      for (let i = 1; i <= 13; i += 1) {
        const result = publish({ id: 'plan', html: `<p>v${i}` });
        expect(result.ok).toBe(true);
        if (result.ok) {
          key = result.stored.key;
        }
      }

      const kept = readdirSync(join(root, RUN, 'plan'))
        .filter((n) => n.endsWith('.html'))
        .sort((a, b) => Number(/\d+/.exec(a)![0]) - Number(/\d+/.exec(b)![0]));
      expect(kept).toEqual(
        [4, 5, 6, 7, 8, 9, 10, 11, 12, 13].map((v) => `v${v}.html`),
      );
      // The window that survives is readable…
      expect(store.read(RUN, 'plan', 13, key)).toBe('<p>v13');
      expect(store.read(RUN, 'plan', 4, key)).toBe('<p>v4');
      // …and a card naming a pruned version gets the route's ordinary refusal.
      expect(store.read(RUN, 'plan', 3, key)).toBeNull();
    });

    it('prunes a version an earlier interrupted prune left behind', () => {
      // It reads the directory rather than deleting one computed name, so a
      // prune that did not finish cannot strand a file nothing looks at again.
      for (let i = 1; i <= 11; i += 1) {
        publish({ id: 'plan', html: `<p>v${i}` });
      }
      // Put a long-dead version back, as a half-finished prune would have.
      writeFileSync(join(root, RUN, 'plan', 'v1.html'), '<p>stray', 'utf8');

      publish({ id: 'plan', html: '<p>v12' });

      expect(existsSync(join(root, RUN, 'plan', 'v1.html'))).toBe(false);
    });

    it('keeps every version while the artifact is under the ceiling', () => {
      let key = '';
      for (let i = 1; i <= 4; i += 1) {
        const result = publish({ id: 'plan', html: `<p>v${i}` });
        if (result.ok) {
          key = result.stored.key;
        }
      }
      expect(store.read(RUN, 'plan', 1, key)).toBe('<p>v1');
      expect(store.read(RUN, 'plan', 4, key)).toBe('<p>v4');
    });

    it('keeps two runs’ artifacts of the same id apart', () => {
      const mine = publish({ id: 'plan', html: '<p>mine' });
      const theirs = publish({ id: 'plan', html: '<p>theirs' }, OTHER_RUN);
      expect(mine.ok && theirs.ok).toBe(true);
      if (!mine.ok || !theirs.ok) {
        return;
      }
      expect(store.read(RUN, 'plan', 1, mine.stored.key)).toBe('<p>mine');
      expect(store.read(OTHER_RUN, 'plan', 1, theirs.stored.key)).toBe(
        '<p>theirs',
      );
    });

    it('refuses an oversize page, naming the limit so the retry can be smaller', () => {
      const result = publish({ html: 'x'.repeat(MAX_ARTIFACT_HTML_BYTES + 1) });
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.reason).toContain('512KB limit');
    });

    it('measures ENCODED bytes, not characters', () => {
      // Three bytes per character: a page well under the character count is
      // still over the byte ceiling, which is what actually reaches the disk.
      const chars = Math.floor(MAX_ARTIFACT_HTML_BYTES / 2);
      const result = publish({ html: '∎'.repeat(chars) });
      expect(chars).toBeLessThan(MAX_ARTIFACT_HTML_BYTES);
      expect(result.ok).toBe(false);
    });

    it('refuses a run id that is not one this app mints', () => {
      expect(publish({ id: 'plan' }, '../../etc').ok).toBe(false);
    });

    it('stores the page under <root>/<runId>/<artifactId>/v1.html', () => {
      publish({ id: 'plan' });
      expect(existsSync(join(root, RUN, 'plan', 'v1.html'))).toBe(true);
    });

    it('writes nothing outside the artifacts root, whatever the id', () => {
      // The negative the name above used to promise and never checked: after
      // a hostile id, the root holds the run's directory and nothing else.
      for (const hostile of ['../escape', '../../etc', 'a/b', '..']) {
        publish({ id: hostile });
      }
      expect(readdirSync(root)).toEqual([RUN]);
    });
  });

  describe('read', () => {
    it('refuses the wrong key', () => {
      const result = publish({ id: 'plan' });
      expect(result.ok).toBe(true);
      expect(store.read(RUN, 'plan', 1, 'f'.repeat(64))).toBeNull();
    });

    it('refuses an empty key, which is what an omitted query param arrives as', () => {
      publish({ id: 'plan' });
      expect(store.read(RUN, 'plan', 1, '')).toBeNull();
    });

    it('answers null rather than reading a file outside the root', () => {
      const secret = join(root, 'secret.html');
      writeFileSync(secret, '<p>not an artifact', 'utf8');
      const result = publish({ id: 'plan' });
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      for (const hostile of ['../..', '../secret', '..', 'a/b']) {
        expect(store.read(RUN, hostile, 1, result.stored.key)).toBeNull();
      }
      // The decoy is still where it was — nothing walked out to it.
      expect(readFileSync(secret, 'utf8')).toBe('<p>not an artifact');
    });

    it('refuses a version that was never published', () => {
      const result = publish({ id: 'plan' });
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(store.read(RUN, 'plan', 2, result.stored.key)).toBeNull();
      expect(store.read(RUN, 'plan', 0, result.stored.key)).toBeNull();
      expect(store.read(RUN, 'plan', -1, result.stored.key)).toBeNull();
      expect(store.read(RUN, 'plan', 1.5, result.stored.key)).toBeNull();
    });

    it('answers null for an artifact nobody published', () => {
      expect(store.read(RUN, 'nothing-here', 1, 'f'.repeat(64))).toBeNull();
    });

    it('answers null rather than throwing on an unreadable meta', () => {
      const result = publish({ id: 'plan' });
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      writeFileSync(join(root, RUN, 'plan', 'meta.json'), 'not json', 'utf8');
      expect(() => store.read(RUN, 'plan', 1, result.stored.key)).not.toThrow();
      expect(store.read(RUN, 'plan', 1, result.stored.key)).toBeNull();
    });
  });

  describe('removeRun', () => {
    it('drops the run’s artifacts and leaves other runs alone', () => {
      const mine = publish({ id: 'plan' });
      const theirs = publish({ id: 'plan' }, OTHER_RUN);
      expect(mine.ok && theirs.ok).toBe(true);
      if (!mine.ok || !theirs.ok) {
        return;
      }
      store.removeRun(RUN);
      expect(store.read(RUN, 'plan', 1, mine.stored.key)).toBeNull();
      expect(store.read(OTHER_RUN, 'plan', 1, theirs.stored.key)).toBe(PAGE);
    });

    it('is idempotent, and a no-op for a run that never published', () => {
      expect(() => store.removeRun(RUN)).not.toThrow();
      expect(() => store.removeRun(RUN)).not.toThrow();
    });

    it('refuses to recurse out of the root on a run id it did not mint', () => {
      const keep = join(root, 'keep.html');
      writeFileSync(keep, 'x', 'utf8');
      store.removeRun('../..');
      expect(existsSync(keep)).toBe(true);
    });
  });
});
