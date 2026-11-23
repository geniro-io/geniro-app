import { execFileSync } from 'node:child_process';
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import type { Plugin } from 'vite';

import {
  addToReleases,
  type ChangelogRelease,
  type ChangelogSection,
  parseChangelog,
  parseFragment,
  renderChangelog,
} from '../src/shared/changelog.ts';
import { compareVersions } from '../src/shared/version.ts';

export const CHANGELOG_FILE = 'CHANGELOG.md';
export const FRAGMENTS_DIR = 'changelog/unreleased';
export const CHANGELOG_MODULE_ID = 'virtual:geniro-changelog';

const RESOLVED_MODULE_ID = `\0${CHANGELOG_MODULE_ID}`;
const RELEASE_TAG = /^v\d+\.\d+\.\d+$/;

export interface ChangelogFragment {
  /** Repository-relative, forward slashes. */
  path: string;
  sections: ChangelogSection[];
}

export interface FragmentRelease {
  version: string;
  date: string;
}

function readDocument(root: string): ReturnType<typeof parseChangelog> {
  const file = join(root, CHANGELOG_FILE);
  return existsSync(file)
    ? parseChangelog(readFileSync(file, 'utf8'), CHANGELOG_FILE)
    : { preamble: '# Changelog', releases: [] };
}

export function readFragments(root: string): ChangelogFragment[] {
  const dir = join(root, FRAGMENTS_DIR);
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((name) => name.endsWith('.md') && !name.startsWith('.'))
    .sort()
    .map((name) => {
      const path = `${FRAGMENTS_DIR}/${name}`;
      return {
        path,
        sections: parseFragment(readFileSync(join(dir, name), 'utf8'), path),
      };
    });
}

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function commitsAddingFragments(root: string): Map<string, string> {
  const added = new Map<string, string>();
  let commit: string | null = null;
  const log = git(root, [
    'log',
    '--diff-filter=A',
    '--format=commit %H',
    '--name-only',
    '--',
    FRAGMENTS_DIR,
  ]);
  for (const line of log.split('\n')) {
    if (line.startsWith('commit ')) {
      commit = line.slice('commit '.length).trim();
    } else if (
      line.trim() !== '' &&
      commit !== null &&
      !added.has(line.trim())
    ) {
      added.set(line.trim(), commit);
    }
  }
  return added;
}

function firstReleaseContaining(
  root: string,
  commit: string,
): FragmentRelease | null {
  const tags = git(root, ['tag', '--contains', commit, '--list', 'v*'])
    .split('\n')
    .map((tag) => tag.trim())
    .filter((tag) => RELEASE_TAG.test(tag))
    .sort(compareVersions);
  const tag = tags[0];
  if (tag === undefined) {
    return null;
  }
  const date = git(root, ['log', '-1', '--format=%cs', tag]).trim();
  return { version: tag.slice(1), date };
}

/**
 * The release each fragment shipped in: the lowest `v*` tag containing the
 * commit that added it. Not yet tagged, not a repository, or a git that cannot
 * answer — the fragment is unreleased (`null`); this never throws.
 */
export function resolveFragmentReleases(
  root: string,
  paths: readonly string[],
): Map<string, FragmentRelease | null> {
  const resolved = new Map<string, FragmentRelease | null>(
    paths.map((path) => [path, null]),
  );
  try {
    const added = commitsAddingFragments(root);
    const byCommit = new Map<string, FragmentRelease | null>();
    for (const path of paths) {
      const commit = added.get(path);
      if (commit === undefined) {
        continue;
      }
      if (!byCommit.has(commit)) {
        byCommit.set(commit, firstReleaseContaining(root, commit));
      }
      resolved.set(path, byCommit.get(commit) ?? null);
    }
  } catch {
    return new Map(paths.map((path) => [path, null]));
  }
  return resolved;
}

function fragmentsAsReleases(
  fragments: readonly ChangelogFragment[],
  resolved: ReadonlyMap<string, FragmentRelease | null>,
): ChangelogRelease[] {
  return fragments.map((fragment) => {
    const release = resolved.get(fragment.path) ?? null;
    return {
      version: release?.version ?? null,
      date: release?.date ?? null,
      sections: fragment.sections,
    };
  });
}

/** Every release the app shows: `CHANGELOG.md` plus each fragment under the release that carries it. */
export function loadChangelog(root: string): ChangelogRelease[] {
  const document = readDocument(root);
  const fragments = readFragments(root);
  const resolved = resolveFragmentReleases(
    root,
    fragments.map((fragment) => fragment.path),
  );
  return addToReleases(
    document.releases,
    fragmentsAsReleases(fragments, resolved),
  );
}

/**
 * Move every released fragment into `CHANGELOG.md` under its version and
 * delete it; unreleased fragments stay. Answers the paths it folded.
 */
export function foldChangelog(root: string): string[] {
  const document = readDocument(root);
  const fragments = readFragments(root);
  const resolved = resolveFragmentReleases(
    root,
    fragments.map((fragment) => fragment.path),
  );
  const released = fragments.filter(
    (fragment) => resolved.get(fragment.path) != null,
  );
  if (released.length === 0) {
    return [];
  }
  const releases = addToReleases(
    document.releases,
    fragmentsAsReleases(released, resolved),
  );
  writeFileSync(
    join(root, CHANGELOG_FILE),
    renderChangelog({ preamble: document.preamble, releases }),
  );
  for (const fragment of released) {
    rmSync(join(root, fragment.path));
  }
  return released.map((fragment) => fragment.path);
}

/** Parse `CHANGELOG.md` and every fragment; throws on the first malformed line. */
export function checkChangelog(root: string): {
  releases: number;
  fragments: number;
} {
  return {
    releases: readDocument(root).releases.length,
    fragments: readFragments(root).length,
  };
}

/** Serves the parsed changelog to the renderer as `virtual:geniro-changelog`. */
export function changelogPlugin(root: string): Plugin {
  return {
    name: 'geniro-changelog',
    resolveId(id) {
      return id === CHANGELOG_MODULE_ID ? RESOLVED_MODULE_ID : null;
    },
    load(id) {
      if (id !== RESOLVED_MODULE_ID) {
        return null;
      }
      this.addWatchFile(join(root, CHANGELOG_FILE));
      for (const fragment of readFragments(root)) {
        this.addWatchFile(join(root, fragment.path));
      }
      return `export default ${JSON.stringify(loadChangelog(root))};`;
    },
  };
}
