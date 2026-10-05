import { repositoryRootOf } from '../../../utils/repository-root';

/**
 * The key claude files a folder under in its home config's `projects` map.
 *
 * NOT the folder itself, and that is the whole reason this exists: geniro
 * wrote the MCP toggle to `projects[<cwd>]` and the CLI never read it. The CLI
 * keys project state by the REPOSITORY a folder belongs to — and for a git
 * worktree, by the MAIN repository the worktree was cut from — so a chat
 * running in a subfolder, or in any worktree (every task card runs in one),
 * had a switch that moved on screen and changed nothing. Probe-verified on
 * 2.1.280 under an isolated `CLAUDE_CONFIG_DIR`: from `repo/sub`,
 * `projects[repo/sub].disabledMcpServers` left the server dialled and
 * `projects[repo]` disabled it; from a worktree, `projects[<worktree>]` did
 * nothing and `projects[<main repo>]` disabled it.
 *
 * Transcribed from the shipped 2.1.280 bundle rather than inferred from those
 * two probes:
 *
 * - the starting folder is `realpathSync(process.cwd())`, NFC-normalized
 *   (`pIr`) — so a symlinked or `/tmp`-style path is keyed by where it really is;
 * - walk UP from it for the first `.git` ENTRY, a directory or a file, a
 *   symlink counting when it names either (`Kt` → `Ce`);
 * - that root's `.git`, when it is a FILE naming a worktree gitdir, is followed
 *   back to the repository it belongs to — only after the gitdir's own
 *   `commondir` and `gitdir` files agree that it is one (`ve` → `Bt`), so a
 *   stray or hand-written `gitdir:` line resolves to the folder itself;
 * - no repository at all → the folder itself;
 * - and the result is `path.normalize`d (`nrt` → `V$`).
 *
 * The CLI's extra path-safety guards (UNC and traversal refusals on the
 * `gitdir:` values) are not repeated: a value they refuse is also one the
 * cross-checks below refuse, which lands on the same answer — the worktree's
 * own root.
 *
 * Never throws. A folder that cannot be resolved keys as itself, which is what
 * the CLI does with a `cwd` it cannot canonicalize.
 *
 * The walk itself is the agent-agnostic `repositoryRootOf`, which the Stats
 * page also files spend under; what is claude's here is the FACT that this is
 * the key it uses.
 */
export function claudeProjectKey(cwd: string): Promise<string> {
  return repositoryRootOf(cwd);
}
