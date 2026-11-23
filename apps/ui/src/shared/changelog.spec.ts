import { describe, expect, it } from 'vitest';

import {
  addToReleases,
  type ChangelogRelease,
  digestReleases,
  parseChangelog,
  parseFragment,
  planWhatsNew,
  renderChangelog,
} from './changelog';

const DOC = `# Changelog

Intro line.

## 1.2.0 — 2026-03-02

### New

- Search the **changelog**

### Internal

- Rename a helper

## 1.1.0 — 2026-02-01

### Fixed

- Keep the \`dialog\` open
`;

function release(
  version: string,
  kind: 'new' | 'improved' | 'fixed' | 'internal' = 'new',
): ChangelogRelease {
  return {
    version,
    date: '2026-01-01',
    sections: [{ kind, entries: [{ text: `entry ${version}` }] }],
  };
}

describe('parseChangelog', () => {
  it('reads releases, their sections and entries, and keeps the preamble', () => {
    expect(parseChangelog(DOC)).toEqual({
      preamble: '# Changelog\n\nIntro line.',
      releases: [
        {
          version: '1.2.0',
          date: '2026-03-02',
          sections: [
            { kind: 'new', entries: [{ text: 'Search the **changelog**' }] },
            { kind: 'internal', entries: [{ text: 'Rename a helper' }] },
          ],
        },
        {
          version: '1.1.0',
          date: '2026-02-01',
          sections: [
            { kind: 'fixed', entries: [{ text: 'Keep the `dialog` open' }] },
          ],
        },
      ],
    });
  });

  it('round-trips through renderChangelog', () => {
    expect(renderChangelog(parseChangelog(DOC))).toBe(DOC);
  });

  it('takes a released New entry with no description, as the seeded history has', () => {
    expect(
      parseChangelog('## 1.0.0 — 2026-01-01\n\n### New\n\n- Bare\n').releases[0]
        ?.sections,
    ).toEqual([{ kind: 'new', entries: [{ text: 'Bare' }] }]);
  });

  it('reads a description under an entry and writes it back unchanged', () => {
    const doc = [
      '# Changelog',
      '',
      '## 1.0.0 — 2026-01-01',
      '',
      '### New',
      '',
      '- Search',
      '',
      '  Find any change by its words.',
      '',
      '- Filter',
      '',
      '### Fixed',
      '',
      '- Works',
      '',
    ].join('\n');

    expect(parseChangelog(doc).releases[0]?.sections[0]?.entries).toEqual([
      { text: 'Search', description: 'Find any change by its words.' },
      { text: 'Filter' },
    ]);
    expect(renderChangelog(parseChangelog(doc))).toBe(doc);
  });

  it.each([
    [
      'an unknown section',
      '## 1.0.0 — 2026-01-01\n\n### Added\n\n- x\n',
      /unknown section "Added"/,
    ],
    [
      'sections out of order',
      '## 1.0.0 — 2026-01-01\n\n### Fixed\n\n- x\n\n### New\n\n- y\n',
      /out of order/,
    ],
    [
      'an empty section',
      '## 1.0.0 — 2026-01-01\n\n### New\n\n### Fixed\n\n- y\n',
      /"New" has no entries/,
    ],
    [
      'a release with no sections',
      '## 1.0.0 — 2026-01-01\n\n',
      /release 1.0.0 has no sections/,
    ],
    [
      'releases oldest first',
      '## 1.0.0 — 2026-01-01\n\n### New\n\n- x\n\n## 1.1.0 — 2026-01-02\n\n### New\n\n- y\n',
      /must come below 1.0.0/,
    ],
    [
      'a malformed release heading',
      '## v1.0.0 (2026-01-01)\n\n### New\n\n- x\n',
      /release heading must read/,
    ],
    [
      'a stray paragraph',
      '## 1.0.0 — 2026-01-01\n\n### New\n\nsome prose\n',
      /expected "### <Section>", "- <entry>" or a description indented two spaces/,
    ],
  ])('refuses %s, naming the line', (_name, text, message) => {
    expect(() => parseChangelog(text)).toThrow(message);
    expect(() => parseChangelog(text)).toThrow(/^CHANGELOG\.md:\d+: /);
  });
});

describe('parseFragment', () => {
  it('reads the sections of one change, each New entry with its description', () => {
    expect(
      parseFragment(
        [
          '### New',
          '',
          '- One',
          '',
          '  What one is',
          '  and why.',
          '- Two',
          '  Two in short.',
          '',
          '### Fixed',
          '',
          '- Three',
          '',
        ].join('\n'),
        'f.md',
      ),
    ).toEqual([
      {
        kind: 'new',
        entries: [
          { text: 'One', description: 'What one is and why.' },
          { text: 'Two', description: 'Two in short.' },
        ],
      },
      { kind: 'fixed', entries: [{ text: 'Three' }] },
    ]);
  });

  it('refuses a New entry with no description, naming its line', () => {
    expect(() =>
      parseFragment('### New\n\n- Described\n\n  Why.\n- Bare\n', 'f.md'),
    ).toThrow(/^f\.md:6: "Bare" is a New entry with no description/);
  });

  it('takes a one-line Fixed, Improved or Internal entry with no description', () => {
    expect(
      parseFragment(
        '### Improved\n\n- Faster\n\n### Fixed\n\n- Works\n\n### Internal\n\n- Tidy\n',
        'f.md',
      ).map((section) => section.entries),
    ).toEqual([[{ text: 'Faster' }], [{ text: 'Works' }], [{ text: 'Tidy' }]]);
  });

  it('refuses a description before any entry', () => {
    expect(() => parseFragment('### Fixed\n\n  Stray\n', 'f.md')).toThrow(
      /^f\.md:3: description before any entry/,
    );
  });

  it('refuses a release heading inside a fragment', () => {
    expect(() =>
      parseFragment('## 1.0.0 — 2026-01-01\n\n### New\n\n- x\n', 'f.md'),
    ).toThrow(/^f\.md:1: /);
  });

  it('refuses an empty fragment', () => {
    expect(() => parseFragment('\n', 'f.md')).toThrow(
      /fragment has no sections/,
    );
  });
});

describe('addToReleases', () => {
  it('appends to an existing version in section order and keeps its date', () => {
    const merged = addToReleases(
      [
        {
          version: '1.0.0',
          date: '2026-01-01',
          sections: [{ kind: 'fixed', entries: [{ text: 'a' }] }],
        },
      ],
      [
        {
          version: '1.0.0',
          date: '2026-09-09',
          sections: [
            { kind: 'new', entries: [{ text: 'b' }] },
            { kind: 'fixed', entries: [{ text: 'c' }] },
          ],
        },
      ],
    );

    expect(merged).toEqual([
      {
        version: '1.0.0',
        date: '2026-01-01',
        sections: [
          { kind: 'new', entries: [{ text: 'b' }] },
          { kind: 'fixed', entries: [{ text: 'a' }, { text: 'c' }] },
        ],
      },
    ]);
  });

  it('orders versions numerically, newest first, with the unreleased group on top', () => {
    const merged = addToReleases(
      [release('1.9.0'), release('1.10.0')],
      [
        {
          version: null,
          date: null,
          sections: [{ kind: 'new', entries: [{ text: 'x' }] }],
        },
        release('1.2.0'),
      ],
    );

    expect(merged.map((r) => r.version)).toEqual([
      null,
      '1.10.0',
      '1.9.0',
      '1.2.0',
    ]);
  });
});

describe('planWhatsNew', () => {
  const releases = [
    {
      version: null,
      date: null,
      sections: [{ kind: 'new' as const, entries: [{ text: 'unreleased' }] }],
    },
    release('1.4.0'),
    release('1.3.0', 'internal'),
    release('1.2.0', 'fixed'),
    release('1.1.0'),
  ];
  const base = { releases, isPackaged: true, onboardingComplete: true };

  it('shows every release after the last seen up to the running one, Internal left out', () => {
    const plan = planWhatsNew({ ...base, lastSeen: '1.1.0', current: '1.4.0' });

    expect(plan.show.map((r) => r.version)).toEqual(['1.4.0', '1.2.0']);
    expect(plan.record).toBe('1.4.0');
    expect(plan.since).toBe('1.1.0');
  });

  it('records silently when the skipped releases hold only Internal entries', () => {
    const plan = planWhatsNew({ ...base, lastSeen: '1.2.0', current: '1.3.0' });

    expect(plan).toEqual({ show: [], record: '1.3.0', since: '1.2.0' });
  });

  it('opens nothing and records nothing once the running version was seen', () => {
    expect(
      planWhatsNew({ ...base, lastSeen: '1.4.0', current: '1.4.0' }),
    ).toEqual({
      show: [],
      record: null,
      since: null,
    });
  });

  it('records without showing on a fresh install that has not finished onboarding', () => {
    const plan = planWhatsNew({
      ...base,
      onboardingComplete: false,
      lastSeen: null,
      current: '1.4.0',
    });

    expect(plan).toEqual({ show: [], record: '1.4.0', since: null });
  });

  it('shows only the running release to a profile that never recorded one', () => {
    const plan = planWhatsNew({ ...base, lastSeen: null, current: '1.4.0' });

    expect(plan.show.map((r) => r.version)).toEqual(['1.4.0']);
    expect(plan.since).toBeNull();
  });

  it('records without showing after a downgrade', () => {
    expect(
      planWhatsNew({ ...base, lastSeen: '1.4.0', current: '1.2.0' }),
    ).toEqual({
      show: [],
      record: '1.2.0',
      since: '1.4.0',
    });
  });

  it('takes no part in an unpackaged build', () => {
    expect(
      planWhatsNew({
        ...base,
        isPackaged: false,
        lastSeen: '1.1.0',
        current: '1.4.0',
      }),
    ).toEqual({
      show: [],
      record: null,
      since: null,
    });
  });

  it('reads an unparseable record as none', () => {
    const plan = planWhatsNew({
      ...base,
      lastSeen: 'garbage',
      current: '1.4.0',
    });

    expect(plan.show.map((r) => r.version)).toEqual(['1.4.0']);
    expect(plan.since).toBeNull();
  });
});

describe('digestReleases', () => {
  it('lists each kind once, in kind order, with every release’s entries tagged and Internal left out', () => {
    expect(
      digestReleases([
        {
          version: '1.3.0',
          date: '2026-03-01',
          sections: [
            { kind: 'new', entries: [{ text: 'n3' }] },
            { kind: 'fixed', entries: [{ text: 'f3a' }, { text: 'f3b' }] },
            { kind: 'internal', entries: [{ text: 'i3' }] },
          ],
        },
        {
          version: '1.2.0',
          date: '2026-02-01',
          sections: [
            { kind: 'improved', entries: [{ text: 'm2' }] },
            { kind: 'fixed', entries: [{ text: 'f2' }] },
          ],
        },
      ]),
    ).toEqual([
      { kind: 'new', entries: [{ text: 'n3', version: '1.3.0' }] },
      { kind: 'improved', entries: [{ text: 'm2', version: '1.2.0' }] },
      {
        kind: 'fixed',
        entries: [
          { text: 'f3a', version: '1.3.0' },
          { text: 'f3b', version: '1.3.0' },
          { text: 'f2', version: '1.2.0' },
        ],
      },
    ]);
  });

  it('is empty when the releases hold only Internal entries', () => {
    expect(digestReleases([release('1.1.0', 'internal')])).toEqual([]);
  });
});
