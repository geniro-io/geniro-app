import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Config every git call on a folder the USER named is made under, ahead of the
 * subcommand — `git-info.ts`, `git-changes.ts` and `worktree-service.ts` alike.
 *
 * The folder's `.git/config` is data that travels with a repository — an
 * archive, a copied folder, a checkout an agent was pointed at — so it is
 * untrusted input. `core.fsmonitor` names a PROGRAM git runs on any command
 * that reads the index, so without the refusal drawing the composer's branch
 * chip would run whatever that config asked for. `-c` beats the repository's
 * value and there is no per-invocation opt-out, so refusing it by name is the
 * whole mechanism.
 *
 * `core.quotePath=false` is correctness rather than safety: it is ON by
 * default, so a non-ASCII branch or path comes back as C-style escapes
 * (`\320\277`) that no consumer here un-escapes.
 *
 * This is the half that needs no knowledge of the repository, and it is what an
 * ACTION runs under — see {@link readSafeConfig} for the half a READ adds.
 */
export const SAFE_CONFIG: readonly string[] = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.quotePath=false',
];

/**
 * The flag every READ that compares the working tree passes (`status`,
 * `diff` against the tree).
 *
 * Without it git walks into each checked-out submodule and runs `status`
 * THERE, under the submodule's own `.git/modules/<name>/config` — which the
 * filter discovery below never read, so a clean filter defined only in a
 * submodule ran on a plain `git status` of the parent. Measured. `dirty` still
 * reports a submodule whose recorded COMMIT moved; it stops only the look
 * inside, which is exactly the part that runs the submodule's config.
 */
export const IGNORE_SUBMODULE_WORKTREES = '--ignore-submodules=dirty';

/**
 * Config scopes that are the USER's own rather than the repository's: their
 * `~/.gitconfig`, the machine's, and the `-c`/environment of this process. A
 * filter defined there — git-lfs's, most commonly — is a program the user
 * installed and chose, and neutralising it would make every read of an LFS
 * checkout disagree with the user's own terminal (a touched LFS file hashes
 * as its full content against a pointer in the index, and reads as modified).
 */
const TRUSTED_SCOPES = new Set(['system', 'global', 'command']);

/**
 * The repository-defined filter drivers in a `git config --show-scope
 * --name-only -z --get-regexp '^filter\.'` listing — or null when one of them
 * cannot be neutralised.
 *
 * The listing is `<scope>\0<key>\0` per entry. A key is `filter.<name>.<var>`,
 * and `<name>` is everything between the first and LAST dot, since a driver
 * name may itself contain dots (`filter.Mixed.Case.clean` is driver
 * `Mixed.Case`). An include pulled in by the repository's config reports the
 * scope of the file that included it (`local`), so an `include.path` cannot
 * launder a driver into looking like the user's own.
 *
 * A name holding `=` is refused outright rather than skipped: `git -c` splits
 * its argument at the FIRST `=`, so `-c filter.x=y.clean=` sets a key called
 * `filter.x` and neutralises nothing — measured, the driver still ran. No real
 * tool names a filter that way, so failing closed costs nobody anything.
 */
function untrustedFilterDrivers(listing: string): string[] | null {
  const fields = listing.split('\0');
  const names = new Set<string>();
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const scope = fields[index]!;
    const key = fields[index + 1]!;
    if (TRUSTED_SCOPES.has(scope)) {
      continue;
    }
    const last = key.lastIndexOf('.');
    if (!key.startsWith('filter.') || last <= 'filter.'.length - 1) {
      continue;
    }
    const name = key.slice('filter.'.length, last);
    if (name.includes('=')) {
      return null;
    }
    names.add(name);
  }
  return [...names];
}

/** The numeric exit status an `execFile` rejection carries, if any. */
function exitStatus(error: unknown): number | null {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;
  return typeof code === 'number' ? code : null;
}

/**
 * {@link SAFE_CONFIG} plus an override for every filter driver the REPOSITORY
 * defines — the config every READ of a folder runs under. Null when the
 * repository's config cannot be read or cannot be neutralised, which every
 * caller treats as "git could not answer" rather than reading without it.
 *
 * **Why filters.** A `.gitattributes` line `f.txt filter=evil` plus a
 * `filter.evil.clean` command in `.git/config` makes git RUN that command
 * whenever it re-hashes `f.txt` — which `status` does for any file whose stat
 * data moved, and `diff` against the tree does too (`--no-textconv` covers the
 * diff driver, not this). Measured on a real repository: a touched file and a
 * plain `git status` ran it. There is no switch that turns filters off, so each
 * driver is named and emptied: `clean`/`smudge`/`process` set to the empty
 * command is "no filter" to git, and `required=false` is not optional — a
 * required driver with no command makes `status` die with `clean filter 'x'
 * failed` (measured), which would read here as a dirty tree.
 *
 * **Why only a READ.** `git config --get-regexp` itself runs nothing, so the
 * discovery is safe to make first. The overrides belong to the calls that only
 * LOOK: a composer chip, the changes dialog, the reaper's dirty check — the
 * ones that run because a folder was opened, not because the user asked git to
 * do something. A switch, a pull, a stash or a commit keeps the repository's
 * filters, because a filter is part of what a checkout MEANS: git-crypt's clean
 * is what keeps a secret encrypted in a commit, git-lfs's smudge is what puts
 * the real file on disk, and running either without them would write the
 * wrong bytes into the user's own repository. Those are presses, and run git
 * the way the user's terminal would.
 */
export async function readSafeConfig(
  dir: string,
  timeoutMs = 5000,
): Promise<string[] | null> {
  let listing = '';
  try {
    const { stdout } = await execFileAsync(
      'git',
      [
        ...SAFE_CONFIG,
        'config',
        '--show-scope',
        '--name-only',
        '-z',
        '--get-regexp',
        '^filter\\.',
      ],
      { cwd: dir, timeout: timeoutMs, maxBuffer: 1024 * 1024 },
    );
    listing = stdout;
  } catch (error) {
    // Exit 1 is git's "no key matched" — a repository with no filters at all,
    // the ordinary case. Anything else (no such directory, no git, an
    // unreadable config) is an answer nobody could vouch for.
    if (exitStatus(error) !== 1) {
      return null;
    }
  }
  const drivers = untrustedFilterDrivers(listing);
  if (drivers === null) {
    return null;
  }
  return [
    ...SAFE_CONFIG,
    ...drivers.flatMap((name) => [
      '-c',
      `filter.${name}.clean=`,
      '-c',
      `filter.${name}.smudge=`,
      '-c',
      `filter.${name}.process=`,
      '-c',
      `filter.${name}.required=false`,
    ]),
  ];
}
