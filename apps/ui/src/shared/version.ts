/** Parse `1.2.3` / `v1.2.3` into a `[major, minor, patch]` tuple, or null. */
export function parseVersion(value: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * Order two versions numerically per component, so `1.10.0` sorts after
 * `1.9.0`. Negative when `a` is older, positive when newer, 0 when equal or
 * when either side is unparseable.
 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) {
    return 0;
  }
  for (let i = 0; i < 3; i += 1) {
    const diff = left[i]! - right[i]!;
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

/**
 * Is `candidate` a newer release than `current`? An unparseable version on
 * either side answers `false`: refusing to update is the safe reading of "we
 * cannot tell".
 */
export function isNewerVersion(candidate: string, current: string): boolean {
  if (!parseVersion(candidate) || !parseVersion(current)) {
    return false;
  }
  return compareVersions(candidate, current) > 0;
}
