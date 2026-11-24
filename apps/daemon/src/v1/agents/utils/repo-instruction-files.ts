import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { AgentRepoInstructions } from '../adapters/adapter.types';
import { approxInstructionTokens } from './agent-instructions';
import { readInstructionFile } from './user-instruction-files';

const MAX_IMPORT_DEPTH = 5;

const IMPORT_PATTERN = /(?:^|\s)@((?:~\/|\.{1,2}\/|\/)?[^\s`'"<>()[\]]+)/g;

export interface RepoInstructionFile {
  path: string;
  /** The file that imports it; null for one the CLI loads by its name or folder. */
  importedFrom: string | null;
  /** Null for a file too large to read or that could not be read. */
  chars: number | null;
  approxTokens: number | null;
}

export type RepoInstructionFiles =
  | {
      kind: 'measured';
      /** The repository root the walk stopped at, or the folder itself outside a repository. */
      root: string;
      files: RepoInstructionFile[];
      chars: number;
      approxTokens: number;
    }
  | { kind: 'unavailable'; reason: string };

/**
 * The repository files a CLI loads into a session started in `folder`, as
 * they stand on disk now: its file names in the folder and every folder above
 * it up to the repository root, the rules under the root that name no
 * `paths:`, and what those import.
 */
export async function measureRepoInstructionFiles(
  spec: AgentRepoInstructions,
  folder: string,
  home: string = homedir(),
): Promise<RepoInstructionFiles> {
  if (spec.kind === 'unavailable') {
    return { kind: 'unavailable', reason: spec.reason };
  }
  if (!(await isDirectory(folder))) {
    return {
      kind: 'unavailable',
      reason: 'the folder the session started in is no longer on disk',
    };
  }
  const root = (await repositoryRootOf(folder)) ?? folder;
  const seen = new Set<string>();
  const files: RepoInstructionFile[] = [];
  const take = async (
    path: string,
    importedFrom: string | null,
    depth: number,
  ): Promise<void> => {
    const absolute = resolve(path);
    if (seen.has(absolute)) {
      return;
    }
    const { exists, text } = await readInstructionFile(absolute);
    if (exists !== true) {
      return;
    }
    seen.add(absolute);
    files.push({
      path: absolute,
      importedFrom,
      chars: text?.length ?? null,
      approxTokens: text === null ? null : approxInstructionTokens(text.length),
    });
    if (text === null || !spec.atImports || depth >= MAX_IMPORT_DEPTH) {
      return;
    }
    for (const target of importsOf(text, dirname(absolute), home)) {
      await take(target, absolute, depth + 1);
    }
  };
  for (const dir of foldersFromRoot(root, folder)) {
    for (const name of spec.fileNames) {
      await take(join(dir, name), null, 0);
    }
  }
  if (spec.rulesDir !== null) {
    for (const rule of await markdownFilesUnder(join(root, spec.rulesDir))) {
      const { text } = await readInstructionFile(rule);
      if (text !== null && !namesPaths(text)) {
        await take(rule, null, 0);
      }
    }
  }
  const chars = files.reduce((sum, file) => sum + (file.chars ?? 0), 0);
  return {
    kind: 'measured',
    root,
    files,
    chars,
    approxTokens: files.reduce(
      (sum, file) => sum + (file.approxTokens ?? 0),
      0,
    ),
  };
}

/** The `@path` imports of a file, resolved; code spans and blocks import nothing. */
export function importsOf(text: string, from: string, home: string): string[] {
  const prose = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
  return [...prose.matchAll(IMPORT_PATTERN)].map(([, target]) => {
    const path = target!.replace(/[.,;:!?]+$/, '');
    if (path.startsWith('~/')) {
      return join(home, path.slice(2));
    }
    return isAbsolute(path) ? path : join(from, path);
  });
}

/** Whether a rule's frontmatter scopes it to `paths:`, so it loads only on a matching read. */
export function namesPaths(text: string): boolean {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  return match !== null && /^paths\s*:/m.test(match[1]!);
}

function foldersFromRoot(root: string, folder: string): string[] {
  const below = relative(root, folder);
  if (below === '' || below.startsWith('..') || isAbsolute(below)) {
    return [root];
  }
  const parts = below.split(sep);
  return [
    root,
    ...parts.map((_, index) => join(root, ...parts.slice(0, index + 1))),
  ];
}

async function repositoryRootOf(folder: string): Promise<string | null> {
  let dir = resolve(folder);
  for (;;) {
    if (await exists(join(dir, '.git'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

async function markdownFilesUnder(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of [...entries].sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await markdownFilesUnder(path)));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      found.push(path);
    }
  }
  return found;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
