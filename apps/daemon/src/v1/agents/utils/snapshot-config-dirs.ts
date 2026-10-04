import { asArray, asRecord, asString, parseJsonColumn } from './json-util';

/**
 * Each agent node's config directory, read out of a run's
 * `Run.workflowSnapshot` — the copy of the workflow the run actually RAN, which
 * is where a workflow node's profile is fixed (the run row carries none of its
 * own).
 *
 * Read here rather than through the graphs module's snapshot parser, because
 * that module imports this one and not the other way round — and only these two
 * fields are needed. A node naming no directory, and a snapshot that cannot be
 * read, both leave the node out: the caller then uses the CLI's own default
 * profile, which is the one that node ran under.
 */
export function snapshotNodeConfigDirs(
  snapshot: string | null,
): Map<string, string> {
  const dirs = new Map<string, string>();
  for (const entry of asArray(asRecord(parseJsonColumn(snapshot))?.nodes)) {
    const node = asRecord(entry);
    const id = node ? asString(node.id) : null;
    const configDir = node ? asString(node.configDir) : null;
    if (id && configDir && configDir.trim() !== '') {
      dirs.set(id, configDir);
    }
  }
  return dirs;
}
