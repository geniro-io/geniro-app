import { History } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import {
  CHANGELOG_KIND_HEADING,
  CHANGELOG_KINDS,
  type ChangelogKind,
  type ChangelogRelease,
} from '../../shared/changelog';
import {
  ChangelogReleaseCard,
  releaseAnchorId,
} from '../components/changelog-release';
import { EmptyState } from '../components/empty-state';
import { SearchField } from '../components/search-panel';
import { ShowAllButton, useShowAll } from '../components/show-all';
import { Select, type SelectGroup } from '../components/ui/select';

/** How many of the newest releases show before "Show all". */
export const CHANGELOG_PAGE = 20;

const ALL_KINDS = 'all';
const UNRELEASED = 'unreleased';

const KIND_OPTIONS: SelectGroup[] = [
  {
    items: [
      { value: ALL_KINDS, label: 'All changes' },
      ...CHANGELOG_KINDS.map((kind) => ({
        value: kind,
        label: CHANGELOG_KIND_HEADING[kind],
      })),
    ],
  },
];

/**
 * The releases holding a change of `kind` (or any, for null) whose text,
 * description or version contains `query`; each keeps only its matching entries.
 */
export function filterReleases(
  releases: readonly ChangelogRelease[],
  query: string,
  kind: ChangelogKind | null,
): ChangelogRelease[] {
  const needle = query.trim().toLowerCase();
  return releases.flatMap((release) => {
    const versionMatches =
      needle !== '' && (release.version ?? '').includes(needle);
    const sections = release.sections
      .filter((section) => kind === null || section.kind === kind)
      .map((section) => ({
        ...section,
        entries:
          needle === '' || versionMatches
            ? section.entries
            : section.entries.filter((entry) =>
                `${entry.text} ${entry.description ?? ''}`
                  .toLowerCase()
                  .includes(needle),
              ),
      }))
      .filter((section) => section.entries.length > 0);
    return sections.length > 0 ? [{ ...release, sections }] : [];
  });
}

function monthOf(date: string | null): string {
  if (date === null) {
    return 'Not released yet';
  }
  const [year, month] = date.split('-').map(Number);
  return new Date(year ?? 1970, (month ?? 1) - 1, 1).toLocaleDateString(
    'en-US',
    { month: 'long', year: 'numeric' },
  );
}

/** The jump menu: every listed version, grouped under its month. */
function versionGroups(releases: readonly ChangelogRelease[]): SelectGroup[] {
  const groups: SelectGroup[] = [];
  for (const release of releases) {
    const label = monthOf(release.date);
    let group = groups.at(-1);
    if (group?.label !== label) {
      group = { label, items: [] };
      groups.push(group);
    }
    group.items.push({
      value: release.version ?? UNRELEASED,
      label: release.version ?? 'Not released yet',
    });
  }
  return groups;
}

function countEntries(releases: readonly ChangelogRelease[]): number {
  return releases.reduce(
    (sum, release) =>
      sum +
      release.sections.reduce(
        (inner, section) => inner + section.entries.length,
        0,
      ),
    0,
  );
}

/**
 * Settings → What's new: the whole changelog compiled into this build, newest
 * first, searchable, narrowed by kind of change, with a jump to any version.
 */
export function ChangelogPage({
  releases,
  current,
}: {
  releases: readonly ChangelogRelease[];
  /** The running app's version, marked on its release; null until known. */
  current: string | null;
}): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<ChangelogKind | null>(null);
  const [jumpTo, setJumpTo] = useState<string | null>(null);
  const filtered = useMemo(
    () => filterReleases(releases, query, kind),
    [releases, query, kind],
  );
  const { shown, expanded, setExpanded } = useShowAll(filtered, CHANGELOG_PAGE);
  const narrowed = query.trim() !== '' || kind !== null;

  useEffect(() => {
    if (jumpTo === null) {
      return;
    }
    const target = document.getElementById(
      releaseAnchorId(jumpTo === UNRELEASED ? null : jumpTo),
    );
    if (target) {
      target.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
      setJumpTo(null);
    }
  }, [jumpTo, shown]);

  const jump = (value: string): void => {
    const index = filtered.findIndex(
      (release) => (release.version ?? UNRELEASED) === value,
    );
    if (index >= CHANGELOG_PAGE) {
      setExpanded(true);
    }
    setJumpTo(value);
  };

  if (releases.length === 0) {
    return (
      <EmptyState icon={<History />}>
        This build carries no changelog.
      </EmptyState>
    );
  }

  const releasedCount = releases.filter((r) => r.version !== null).length;
  return (
    <div className="flex flex-col gap-5">
      <div
        data-slot="changelog-filters"
        className="flex flex-wrap items-center gap-2">
        <SearchField
          className="min-w-56 flex-1"
          value={query}
          onValueChange={setQuery}
          label="Search the changelog"
          placeholder="Search changes or a version"
        />
        <div data-slot="changelog-selects" className="flex gap-2">
          <div className="w-40">
            <Select
              groups={KIND_OPTIONS}
              value={kind ?? ALL_KINDS}
              onValueChange={(value) =>
                setKind(value === ALL_KINDS ? null : (value as ChangelogKind))
              }
              aria-label="Kind of change"
              title="Show only one kind of change"
            />
          </div>
          <div className="w-44">
            <Select
              groups={versionGroups(filtered)}
              value={null}
              placeholder="Jump to version"
              searchPlaceholder="Find a version"
              onValueChange={jump}
              disabled={filtered.length === 0}
              aria-label="Jump to version"
              title="Scroll to one version’s changes"
            />
          </div>
        </div>
      </div>
      <p
        className="text-xs text-muted-foreground"
        data-slot="changelog-summary">
        {narrowed
          ? `${countEntries(filtered).toLocaleString()} matching ${countEntries(filtered) === 1 ? 'change' : 'changes'} in ${filtered.length.toLocaleString()} ${filtered.length === 1 ? 'version' : 'versions'}`
          : `${releasedCount.toLocaleString()} versions`}
        {current === null ? null : ` · this app is ${current}`}
      </p>
      {filtered.length === 0 ? (
        <EmptyState icon={<History />}>No changes match.</EmptyState>
      ) : (
        <div className="flex flex-col gap-3">
          {shown.map((release) => (
            <ChangelogReleaseCard
              key={release.version ?? UNRELEASED}
              release={release}
              current={release.version !== null && release.version === current}
            />
          ))}
          <ShowAllButton
            className="self-center"
            total={filtered.length}
            limit={CHANGELOG_PAGE}
            expanded={expanded}
            onToggle={() => setExpanded(!expanded)}
            noun="versions"
          />
        </div>
      )}
    </div>
  );
}
