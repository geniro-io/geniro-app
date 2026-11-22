import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function makeRepoDir(): string {
  return mkdtempSync(join(tmpdir(), 'geniro-changes-'));
}

export function removeRepoDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export function runGit(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
}

/** A repo on `main` with one commit, and that commit's sha. */
export function initGitRepo(dir: string): string {
  execFileSync('git', ['init', '-b', 'main', '-q', dir], { cwd: tmpdir() });
  runGit(dir, ['config', 'user.email', 'test@example.com']);
  runGit(dir, ['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-q', '-m', 'init']);
  return runGit(dir, ['rev-parse', 'HEAD']);
}

/** A bare repository standing in for GitHub, wired up as `origin`. */
export function addBareOrigin(dir: string): string {
  const remote = mkdtempSync(join(tmpdir(), 'geniro-origin-'));
  execFileSync('git', ['init', '--bare', '-q', remote], { cwd: tmpdir() });
  runGit(dir, ['remote', 'add', 'origin', remote]);
  return remote;
}

export function commitFileIn(
  dir: string,
  name: string,
  text: string,
  message: string,
): string {
  writeFileSync(join(dir, name), text);
  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-q', '-m', message]);
  return runGit(dir, ['rev-parse', 'HEAD']);
}
