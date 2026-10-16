import type { MenuGroup, MenuItem } from '../components/ui/menu';

/**
 * The names repositories use for their long-lived lines, in the order the
 * picker lists them: the trunk first, then integration, then deploy lines.
 *
 * A fixed list of names rather than a reading of the remote's default branch:
 * the point is a stable landmark at the top of a long list of feature
 * branches, and `dev` beside `main` is exactly the pair the picker should lift
 * out even though only one of them is the default.
 */
const PRIMARY_BRANCHES = [
  'main',
  'master',
  'trunk',
  'develop',
  'development',
  'dev',
  'staging',
  'stage',
  'production',
  'prod',
] as const;

const PRIMARY_RANK = new Map<string, number>(
  PRIMARY_BRANCHES.map((name, rank) => [name, rank]),
);

/**
 * Split a repository's branches into the picker's groups: the primary lines
 * under their own label at the top, every other branch below in git's order.
 *
 * Labels only when there are both kinds — a lone "Main branches" heading over
 * a repository that has nothing else names a distinction the list does not
 * have.
 */
export function branchGroups(
  branches: readonly string[],
  item: (branch: string) => MenuItem,
): MenuGroup[] {
  const primary = branches
    .filter((branch) => PRIMARY_RANK.has(branch))
    .sort((a, b) => PRIMARY_RANK.get(a)! - PRIMARY_RANK.get(b)!);
  const other = branches.filter((branch) => !PRIMARY_RANK.has(branch));
  if (primary.length === 0 || other.length === 0) {
    return [{ items: [...primary, ...other].map(item) }];
  }
  return [
    { label: 'Main branches', items: primary.map(item) },
    { label: 'Branches', items: other.map(item) },
  ];
}
