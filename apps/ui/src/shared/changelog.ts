import { compareVersions, parseVersion } from './version.ts';

export const CHANGELOG_KINDS = [
  'new',
  'improved',
  'fixed',
  'internal',
] as const;

export type ChangelogKind = (typeof CHANGELOG_KINDS)[number];

export const CHANGELOG_KIND_HEADING: Record<ChangelogKind, string> = {
  new: 'New',
  improved: 'Improved',
  fixed: 'Fixed',
  internal: 'Internal',
};

export interface ChangelogSection {
  kind: ChangelogKind;
  entries: string[];
}

/** One release; `version` null is the group of changes no release carries yet. */
export interface ChangelogRelease {
  version: string | null;
  date: string | null;
  sections: ChangelogSection[];
}

export interface ChangelogDocument {
  /** Everything above the first release heading, kept verbatim for a rewrite. */
  preamble: string;
  releases: ChangelogRelease[];
}

const RELEASE_HEADING = /^## (\d+\.\d+\.\d+) — (\d{4}-\d{2}-\d{2})$/;
const SECTION_HEADING = /^### (.+)$/;
const ENTRY = /^- (\S.*)$/;

const KIND_OF_HEADING = new Map<string, ChangelogKind>(
  CHANGELOG_KINDS.map((kind) => [CHANGELOG_KIND_HEADING[kind], kind]),
);

function formatError(source: string, line: number, message: string): Error {
  return new Error(`${source}:${line}: ${message}`);
}

class SectionReader {
  readonly sections: ChangelogSection[] = [];
  readonly source: string;

  constructor(source: string) {
    this.source = source;
  }

  heading(text: string, line: number): void {
    const kind = KIND_OF_HEADING.get(text);
    if (kind === undefined) {
      throw formatError(
        this.source,
        line,
        `unknown section "${text}" (expected ${CHANGELOG_KINDS.map((k) => CHANGELOG_KIND_HEADING[k]).join(', ')})`,
      );
    }
    this.closeSection(line);
    const previous = this.sections.at(-1);
    if (
      previous !== undefined &&
      CHANGELOG_KINDS.indexOf(previous.kind) >= CHANGELOG_KINDS.indexOf(kind)
    ) {
      throw formatError(
        this.source,
        line,
        `section "${text}" is out of order or repeated (order: ${CHANGELOG_KINDS.map((k) => CHANGELOG_KIND_HEADING[k]).join(', ')})`,
      );
    }
    this.sections.push({ kind, entries: [] });
  }

  entry(text: string, line: number): void {
    const section = this.sections.at(-1);
    if (section === undefined) {
      throw formatError(this.source, line, 'entry before any section heading');
    }
    section.entries.push(text.trim());
  }

  closeSection(line: number): void {
    const last = this.sections.at(-1);
    if (last !== undefined && last.entries.length === 0) {
      throw formatError(
        this.source,
        line,
        `section "${CHANGELOG_KIND_HEADING[last.kind]}" has no entries`,
      );
    }
  }

  finish(line: number, owner: string): ChangelogSection[] {
    this.closeSection(line);
    if (this.sections.length === 0) {
      throw formatError(this.source, line, `${owner} has no sections`);
    }
    return this.sections;
  }
}

function readBodyLine(reader: SectionReader, text: string, line: number): void {
  const section = SECTION_HEADING.exec(text);
  if (section) {
    reader.heading(section[1]!.trim(), line);
    return;
  }
  const entry = ENTRY.exec(text);
  if (entry) {
    reader.entry(entry[1]!, line);
    return;
  }
  throw formatError(
    reader.source,
    line,
    `expected "### <Section>" or "- <entry>", got "${text}"`,
  );
}

/** Parse `CHANGELOG.md`; throws on anything outside the format, naming the line. */
export function parseChangelog(
  text: string,
  source = 'CHANGELOG.md',
): ChangelogDocument {
  const lines = text.split(/\r?\n/);
  const preamble: string[] = [];
  const releases: ChangelogRelease[] = [];
  let current: { release: ChangelogRelease; reader: SectionReader } | null =
    null;
  const close = (line: number): void => {
    if (current !== null) {
      current.release.sections = current.reader.finish(
        line,
        `release ${current.release.version}`,
      );
    }
  };
  lines.forEach((raw, index) => {
    const line = index + 1;
    const text = raw.trimEnd();
    const heading = RELEASE_HEADING.exec(text);
    if (heading) {
      close(line);
      const version = heading[1]!;
      const previous = releases.at(-1);
      if (
        previous?.version != null &&
        compareVersions(previous.version, version) <= 0
      ) {
        throw formatError(
          source,
          line,
          `release ${version} must come below ${previous.version} (newest first, no repeats)`,
        );
      }
      const release: ChangelogRelease = {
        version,
        date: heading[2]!,
        sections: [],
      };
      releases.push(release);
      current = { release, reader: new SectionReader(source) };
      return;
    }
    if (current === null) {
      if (text.startsWith('## ')) {
        throw formatError(
          source,
          line,
          `release heading must read "## <x.y.z> — <YYYY-MM-DD>", got "${text}"`,
        );
      }
      preamble.push(raw);
      return;
    }
    if (text === '') {
      return;
    }
    readBodyLine(current.reader, text, line);
  });
  close(lines.length);
  return { preamble: preamble.join('\n').trimEnd(), releases };
}

/** Parse one `changelog/unreleased/*.md` fragment: section headings and entries only. */
export function parseFragment(
  text: string,
  source: string,
): ChangelogSection[] {
  const reader = new SectionReader(source);
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, index) => {
    const text = raw.trimEnd();
    if (text !== '') {
      readBodyLine(reader, text, index + 1);
    }
  });
  return reader.finish(lines.length, 'fragment');
}

/** Both section lists combined, entries of one kind kept in arrival order. */
export function mergeSections(
  a: readonly ChangelogSection[],
  b: readonly ChangelogSection[],
): ChangelogSection[] {
  return CHANGELOG_KINDS.flatMap((kind) => {
    const entries = [...a, ...b]
      .filter((section) => section.kind === kind)
      .flatMap((section) => section.entries);
    return entries.length > 0 ? [{ kind, entries }] : [];
  });
}

/** Releases newest first, the unreleased group (version null) on top. */
export function sortReleases(
  releases: readonly ChangelogRelease[],
): ChangelogRelease[] {
  return [...releases].sort((a, b) => {
    if (a.version === null || b.version === null) {
      return a.version === null ? (b.version === null ? 0 : -1) : 1;
    }
    return compareVersions(b.version, a.version);
  });
}

/**
 * Add `additions` to `releases`: a version already there gets the new entries
 * appended to its sections and keeps its date, any other is inserted in order.
 */
export function addToReleases(
  releases: readonly ChangelogRelease[],
  additions: readonly ChangelogRelease[],
): ChangelogRelease[] {
  const byVersion = new Map<string | null, ChangelogRelease>();
  for (const release of [...releases, ...additions]) {
    const existing = byVersion.get(release.version);
    byVersion.set(
      release.version,
      existing === undefined
        ? { ...release, sections: mergeSections([], release.sections) }
        : {
            ...existing,
            sections: mergeSections(existing.sections, release.sections),
          },
    );
  }
  return sortReleases([...byVersion.values()]);
}

/** The document as `CHANGELOG.md` text; unreleased groups are never written. */
export function renderChangelog(document: ChangelogDocument): string {
  const out: string[] = [document.preamble, ''];
  for (const release of sortReleases(document.releases)) {
    if (release.version === null) {
      continue;
    }
    out.push(`## ${release.version} — ${release.date ?? ''}`, '');
    for (const section of release.sections) {
      out.push(`### ${CHANGELOG_KIND_HEADING[section.kind]}`, '');
      out.push(...section.entries.map((entry) => `- ${entry}`), '');
    }
  }
  return `${out.join('\n').trimEnd()}\n`;
}

/** What a reader is shown: every section but Internal, releases left empty dropped. */
export function userFacingReleases(
  releases: readonly ChangelogRelease[],
): ChangelogRelease[] {
  return releases
    .map((release) => ({
      ...release,
      sections: release.sections.filter(
        (section) => section.kind !== 'internal',
      ),
    }))
    .filter((release) => release.sections.length > 0);
}

export interface WhatsNewInput {
  releases: readonly ChangelogRelease[];
  lastSeen: string | null;
  current: string;
  isPackaged: boolean;
  onboardingComplete: boolean;
}

export interface WhatsNewPlan {
  /** The releases the dialog shows, newest first; empty when it stays shut. */
  show: ChangelogRelease[];
  /** The version to record as seen — at once when `show` is empty, else on close. */
  record: string | null;
  /** The version this profile last saw, which `show` starts after; null when it had none. */
  since: string | null;
}

export interface ChangelogDigestEntry {
  text: string;
  version: string | null;
}

export interface ChangelogDigestSection {
  kind: ChangelogKind;
  entries: ChangelogDigestEntry[];
}

/**
 * Every user-facing change of these releases in one list per kind, kinds in
 * their fixed order, each entry tagged with its release and kept in the
 * releases' order.
 */
export function digestReleases(
  releases: readonly ChangelogRelease[],
): ChangelogDigestSection[] {
  return CHANGELOG_KINDS.filter((kind) => kind !== 'internal')
    .map((kind) => ({
      kind,
      entries: releases.flatMap((release) =>
        release.sections
          .filter((section) => section.kind === kind)
          .flatMap((section) =>
            section.entries.map((text) => ({ text, version: release.version })),
          ),
      ),
    }))
    .filter((section) => section.entries.length > 0);
}

/**
 * Whether this launch opens "What's new", and what it marks as seen. Only a
 * packaged build takes part, and a fresh install or a downgrade records the
 * running version without showing anything. A profile with no record yet that
 * has finished onboarding is shown the running version alone.
 */
export function planWhatsNew(input: WhatsNewInput): WhatsNewPlan {
  const { current, lastSeen } = input;
  const nothing: WhatsNewPlan = { show: [], record: null, since: null };
  if (!input.isPackaged || parseVersion(current) === null) {
    return nothing;
  }
  const seen =
    lastSeen !== null && parseVersion(lastSeen) !== null ? lastSeen : null;
  if (seen !== null && compareVersions(seen, current) === 0) {
    return nothing;
  }
  if (
    (seen === null && !input.onboardingComplete) ||
    (seen !== null && compareVersions(seen, current) > 0)
  ) {
    return { show: [], record: current, since: seen };
  }
  const show = userFacingReleases(
    input.releases.filter(
      (release) =>
        release.version !== null &&
        compareVersions(release.version, current) <= 0 &&
        (seen === null
          ? compareVersions(release.version, current) === 0
          : compareVersions(release.version, seen) > 0),
    ),
  );
  return { show: sortReleases(show), record: current, since: seen };
}
