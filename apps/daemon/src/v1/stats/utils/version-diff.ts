import { FILE_HEADERS_ONLY, formatPatch, structuredPatch } from 'diff';

import type { VersionChangesWire } from '../stats.types';

/** Context lines around each change, as `git diff` prints by default. */
const DIFF_CONTEXT = 3;

/**
 * What one version's graph changed against the previous one's, both as YAML: a unified
 * diff as `git diff` prints it, and how many lines it adds and removes.
 */
export function versionDiff(
  slug: string,
  previousYaml: string,
  nextYaml: string,
): VersionChangesWire {
  const file = `${slug}.team.yaml`;
  const patch = structuredPatch(
    `a/${file}`,
    `b/${file}`,
    previousYaml,
    nextYaml,
    undefined,
    undefined,
    { context: DIFF_CONTEXT },
  );
  let added = 0;
  let removed = 0;
  for (const hunk of patch.hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) {
        added += 1;
      } else if (line.startsWith('-')) {
        removed += 1;
      }
    }
  }
  return {
    added,
    removed,
    diff:
      patch.hunks.length === 0
        ? ''
        : formatPatch(patch, FILE_HEADERS_ONLY).trimEnd(),
  };
}
