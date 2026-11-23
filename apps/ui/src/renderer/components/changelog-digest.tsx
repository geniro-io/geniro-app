import type React from 'react';

import { type ChangelogRelease, digestReleases } from '../../shared/changelog';
import {
  ChangelogEntryLine,
  ChangelogKindHeading,
  ENTRY_LIST_CLASS,
} from './changelog-release';

/**
 * Several releases read as one document: each kind of change once, with every
 * release's entries under it and, when more than one release is in it, the
 * release each entry shipped in, and each entry's description under it.
 * Internal changes are left out.
 */
export function ChangelogDigest({
  releases,
}: {
  releases: readonly ChangelogRelease[];
}): React.JSX.Element {
  const showVersions = new Set(releases.map((r) => r.version)).size > 1;
  return (
    <div data-slot="changelog-digest" className="flex flex-col gap-5">
      {digestReleases(releases).map((section) => (
        <section
          key={section.kind}
          data-kind={section.kind}
          className="flex flex-col gap-2">
          <ChangelogKindHeading kind={section.kind} />
          <ul className={ENTRY_LIST_CLASS}>
            {section.entries.map((entry, index) => (
              <ChangelogEntryLine key={index} kind={section.kind} entry={entry}>
                {showVersions && entry.version !== null ? (
                  <span
                    data-slot="changelog-digest-version"
                    className="ml-2 text-xs whitespace-nowrap text-muted-foreground tabular-nums">
                    {entry.version}
                  </span>
                ) : null}
              </ChangelogEntryLine>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
