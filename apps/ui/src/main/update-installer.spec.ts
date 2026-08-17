import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `ditto` is the one thing stubbed. Everything else is the real filesystem in a
 * temp directory: the rename/restore dance is the whole point of the installer,
 * and a mocked `fs` would pin the calls it makes rather than whether the user's
 * app survives a failed copy.
 */
const mocks = vi.hoisted(() => ({
  ditto: vi.fn<(file: string, args: string[]) => Promise<void>>(),
}));

vi.mock('node:child_process', () => ({
  execFile: (
    file: string,
    args: string[],
    cb: (err: Error | null, result?: unknown) => void,
  ): void => {
    void mocks
      .ditto(file, args)
      .then(() => cb(null, { stdout: '', stderr: '' }))
      .catch((err: Error) => cb(err));
  },
}));

import {
  canWriteBundle,
  installUpdate,
  parseChecksums,
  resolveBundlePath,
} from './update-installer';
import type { LatestRelease } from './updater';

const ZIP_BYTES = Buffer.from('the new Geniro release archive');
const ZIP_NAME = 'Geniro-1.4.0-arm64-mac.zip';
const ZIP_URL = `https://example.test/${ZIP_NAME}`;
const SUMS_URL = 'https://example.test/SHA256SUMS.txt';

function digestOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function release(overrides: Partial<LatestRelease> = {}): LatestRelease {
  return {
    version: '1.4.0',
    zip: { name: ZIP_NAME, url: ZIP_URL },
    checksums: { name: 'SHA256SUMS.txt', url: SUMS_URL },
    ...overrides,
  };
}

/** Serve the checksum text and the archive bytes as real `Response`s. */
function serve(sumsText: string, zip: Buffer = ZIP_BYTES): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) =>
      Promise.resolve(
        url === SUMS_URL
          ? new Response(sumsText)
          : // Sliced to a plain ArrayBuffer: a Node Buffer is a valid body at
            // runtime but not in the DOM `BodyInit` union the types describe.
            new Response(
              zip.buffer.slice(
                zip.byteOffset,
                zip.byteOffset + zip.byteLength,
              ) as ArrayBuffer,
              { headers: { 'content-length': String(zip.length) } },
            ),
      ),
    ) as unknown as typeof fetch,
  );
}

let root: string;
let bundlePath: string;
let workDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'geniro-update-spec-'));
  bundlePath = join(root, 'Applications', 'Geniro.app');
  workDir = join(root, 'work');
  await mkdir(bundlePath, { recursive: true });
  await writeFile(join(bundlePath, 'marker'), 'installed-1.3.0');

  // A `ditto` that really moves bytes, so the swap can be observed: `-x -k`
  // unpacks an archive into a bundle, the two-argument form copies one.
  mocks.ditto.mockImplementation(async (file, args) => {
    if (args[0] === '-x') {
      const unpacked = args[3]!;
      const staged = join(unpacked, basename(bundlePath));
      await mkdir(staged, { recursive: true });
      await writeFile(join(staged, 'marker'), 'installed-1.4.0');
      return;
    }
    if (file.endsWith('xattr')) {
      return;
    }
    const [from, to] = args as [string, string];
    await mkdir(to, { recursive: true });
    await writeFile(join(to, 'marker'), await readFile(join(from, 'marker')));
  });
  serve(`${digestOf(ZIP_BYTES)}  ${ZIP_NAME}\n`);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  mocks.ditto.mockReset();
  await rm(root, { recursive: true, force: true });
});

/** What the bundle at `bundlePath` currently claims to be. */
async function installedVersion(): Promise<string> {
  return readFile(join(bundlePath, 'marker'), 'utf8');
}

describe('resolveBundlePath', () => {
  it('walks up from the executable to the .app', () => {
    expect(
      resolveBundlePath('/Applications/Geniro.app/Contents/MacOS/Geniro'),
    ).toBe('/Applications/Geniro.app');
  });

  it('refuses a translocated copy, which sits on a read-only synthetic mount', () => {
    // Writing there would appear to succeed and change nothing on disk — an
    // update that keeps coming back after every "successful" install.
    expect(
      resolveBundlePath(
        '/private/var/folders/x/AppTranslocation/ABC/d/Geniro.app/Contents/MacOS/Geniro',
      ),
    ).toBeNull();
  });

  it('returns null when the executable is not inside a bundle at all', () => {
    expect(resolveBundlePath('/usr/local/bin/geniro')).toBeNull();
  });
});

describe('canWriteBundle', () => {
  it('answers false for a bundle that is not there', async () => {
    expect(await canWriteBundle(join(root, 'Nope.app'))).toBe(false);
  });

  it('answers true for one this process owns', async () => {
    expect(await canWriteBundle(bundlePath)).toBe(true);
  });
});

describe('parseChecksums', () => {
  it('reads shasum output, including binary-mode entries', () => {
    const a = 'a'.repeat(64);
    const b = 'b'.repeat(64);
    const digests = parseChecksums(
      `${a}  Geniro-1.4.0-arm64-mac.zip\n${b} *Geniro-1.4.0-arm64.dmg\n`,
    );

    expect(digests.get('Geniro-1.4.0-arm64-mac.zip')).toBe(a);
    expect(digests.get('Geniro-1.4.0-arm64.dmg')).toBe(b);
  });

  it('skips lines that are not digests rather than throwing', () => {
    const digests = parseChecksums(
      `# a comment\n\nnot-a-digest  file.zip\n${'c'.repeat(64)}  real.zip\n`,
    );

    expect([...digests.keys()]).toEqual(['real.zip']);
  });
});

describe('installUpdate', () => {
  it('swaps the bundle and cleans up after itself', async () => {
    const stages: string[] = [];

    await installUpdate({
      release: release(),
      bundlePath,
      workDir,
      onStage: (stage) => stages.push(stage),
    });

    expect(await installedVersion()).toBe('installed-1.4.0');
    // No `.old-<pid>` bundle left beside it: a 400MB copy of the previous
    // version in /Applications is not an acceptable souvenir.
    expect(await readdir(join(root, 'Applications'))).toEqual(['Geniro.app']);
    // And no scratch directory left in userData.
    expect(await readdir(workDir)).toEqual([]);
    expect(stages).toEqual(['downloading', 'installing']);
  });

  it('reports download progress against the declared length', async () => {
    const fractions: (number | null)[] = [];

    await installUpdate({
      release: release(),
      bundlePath,
      workDir,
      onProgress: ({ fraction }) => fractions.push(fraction),
    });

    expect(fractions.length).toBeGreaterThan(0);
    expect(fractions.at(-1)).toBe(1);
  });

  it('refuses a release with no published checksum, without touching the app', async () => {
    await expect(
      installUpdate({
        release: release({ checksums: null }),
        bundlePath,
        workDir,
      }),
    ).rejects.toThrow(/SHA256SUMS/);

    // The whole reason the refusal exists: an ad-hoc build has no signature,
    // so an unverifiable download must never reach the bundle.
    expect(await installedVersion()).toBe('installed-1.3.0');
    expect(mocks.ditto).not.toHaveBeenCalled();
  });

  it('refuses a download whose digest does not match the published one', async () => {
    serve(`${digestOf(Buffer.from('some other build'))}  ${ZIP_NAME}\n`);

    await expect(
      installUpdate({ release: release(), bundlePath, workDir }),
    ).rejects.toThrow(/checksum mismatch/);

    expect(await installedVersion()).toBe('installed-1.3.0');
    // Nothing was unpacked either — the refusal is before the archive is
    // opened, not after.
    expect(mocks.ditto).not.toHaveBeenCalled();
  });

  it('refuses when the checksum file carries no entry for this archive', async () => {
    serve(`${digestOf(ZIP_BYTES)}  some-other-asset.zip\n`);

    await expect(
      installUpdate({ release: release(), bundlePath, workDir }),
    ).rejects.toThrow(/no entry for/);

    expect(await installedVersion()).toBe('installed-1.3.0');
  });

  it('puts the original bundle back when the copy fails half-way', async () => {
    const unpack = mocks.ditto.getMockImplementation()!;
    mocks.ditto.mockImplementation(async (file, args) => {
      if (args[0] === '-x') {
        return unpack(file, args);
      }
      throw new Error('ditto: No space left on device');
    });

    await expect(
      installUpdate({ release: release(), bundlePath, workDir }),
    ).rejects.toThrow(/No space left/);

    // The failure lands AFTER the old bundle has been renamed aside, which is
    // the only window in which a user can lose their installed app. Without
    // the restore they would be left with no Geniro at all.
    expect(await installedVersion()).toBe('installed-1.3.0');
    expect(await readdir(join(root, 'Applications'))).toEqual(['Geniro.app']);
  });
});
