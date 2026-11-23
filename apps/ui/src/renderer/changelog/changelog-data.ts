import releases from 'virtual:geniro-changelog';

import type { ChangelogRelease } from '../../shared/changelog';

/** Every release, newest first, compiled into the bundle from `CHANGELOG.md` and `changelog/unreleased/`. */
export const CHANGELOG: readonly ChangelogRelease[] = releases;
