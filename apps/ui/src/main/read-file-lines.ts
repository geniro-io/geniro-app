import { constants as fsConstants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute, join, sep } from 'node:path';

import {
  FILE_LINES_MAX,
  FILE_LINES_MAX_BYTES,
  type FileLines,
  type ReadFileLinesRequest,
} from '../shared/contracts';
import { git, openRepository } from './git-changes';

const BINARY_PROBE_BYTES = 8_000;

const COMMIT_SHA = /^[0-9a-f]{40}$/;

type Content = { content: Buffer } | { refusal: string };

function refused(unavailableReason: string): FileLines {
  return { lines: [], total: 0, unavailableReason };
}

function isRepositoryPath(path: string): boolean {
  return (
    path !== '' &&
    !isAbsolute(path) &&
    !path.includes('\0') &&
    !path.split('/').includes('..')
  );
}

async function readWorktreeFile(root: string, path: string): Promise<Content> {
  let realRoot: string;
  let file: string;
  try {
    realRoot = await realpath(root);
    file = await realpath(join(root, path));
  } catch {
    return { refusal: 'No file at that path in this checkout.' };
  }
  const gitDir = join(realRoot, '.git');
  if (
    !file.startsWith(realRoot + sep) ||
    file === gitDir ||
    file.startsWith(gitDir + sep)
  ) {
    return { refusal: 'That path is outside the repository’s files.' };
  }
  let handle;
  try {
    handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  } catch {
    return { refusal: 'The file could not be opened.' };
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      return { refusal: 'Only regular files can be read.' };
    }
    if (info.size > FILE_LINES_MAX_BYTES) {
      return { refusal: 'The file is larger than 4 MiB.' };
    }
    const buffer = Buffer.alloc(info.size);
    const { bytesRead } = await handle.read(buffer, 0, info.size, 0);
    return { content: buffer.subarray(0, bytesRead) };
  } catch {
    return { refusal: 'The file could not be read.' };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

// `cat-file blob` runs no filter or textconv, and refuses a folder where `git show` would list it.
async function readCommitFile(
  root: string,
  config: readonly string[],
  sha: string,
  path: string,
): Promise<Content> {
  const text = await git(root, ['cat-file', 'blob', `${sha}:${path}`], config);
  if (text === null) {
    return {
      refusal:
        'git could not read this file at that commit, or it is larger than 4 MiB.',
    };
  }
  const content = Buffer.from(text, 'utf8');
  return content.length > FILE_LINES_MAX_BYTES
    ? { refusal: 'The file is larger than 4 MiB.' }
    : { content };
}

function linesOf(content: Buffer): string[] {
  const text = content.toString('utf8');
  if (text === '') {
    return [];
  }
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

export async function readFileLines(
  request: ReadFileLinesRequest,
): Promise<FileLines> {
  const { dir, path, at, from, to } = request;
  if (!isRepositoryPath(path)) {
    return refused(
      'The path must be relative to the repository, without “..”.',
    );
  }
  if (from < 1 || to < from) {
    return refused(
      'The line range must start at line 1 or later and end at or after its first line.',
    );
  }
  if (to - from + 1 > FILE_LINES_MAX) {
    return refused(`Read at most ${FILE_LINES_MAX} lines at a time.`);
  }
  if (at !== 'worktree' && !COMMIT_SHA.test(at.sha)) {
    return refused('The commit must be a full 40-character sha.');
  }
  const repository = await openRepository(dir);
  if (repository === 'not-repo') {
    return refused('Not a git repository.');
  }
  if (repository === 'unsafe') {
    return refused('git could not read this folder.');
  }
  const read =
    at === 'worktree'
      ? await readWorktreeFile(repository.root, path)
      : await readCommitFile(repository.root, repository.config, at.sha, path);
  if ('refusal' in read) {
    return refused(read.refusal);
  }
  if (read.content.subarray(0, BINARY_PROBE_BYTES).includes(0)) {
    return refused('A binary file has no lines to show.');
  }
  const all = linesOf(read.content);
  return {
    lines: all.slice(from - 1, to),
    total: all.length,
    unavailableReason: null,
  };
}
