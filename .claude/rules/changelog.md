---
description: The changelog — one fragment per change, the CHANGELOG.md format, how versions are resolved, folding
paths:
  - "CHANGELOG.md"
  - "changelog/**"
  - "apps/ui/scripts/changelog*"
  - "apps/ui/src/shared/changelog*"
  - "apps/ui/src/renderer/changelog/**"
  - "apps/ui/src/renderer/settings/changelog*"
  - "apps/ui/src/renderer/components/changelog-*"
---

# Changelog

Every pull request adds exactly one fragment, `changelog/unreleased/<short-slug>.md` (the slug names the change, e.g. `whats-new-dialog.md`). The app shows these notes after an update and in Settings → What's new, so they are written for the person using Geniro.

## Writing a fragment

```markdown
### New

- **What's new:** after an update, Geniro shows what changed since the version you last saw

  The first launch after an update opens a short note with every new feature, improvement and fix since the version you had before. Close it and it stays closed until the next update.

### Fixed

- The context readout keeps answering while a codex agent works
```

- Only `### New`, `### Improved`, `### Fixed` and `### Internal` headings, in that order, each followed by `- ` entries. Nothing else: no title, no version, no date.
- Every `New` entry carries a description: one short paragraph under its line, indented two spaces (a blank line before it is fine), saying what the feature is and why a user wants it. A fragment's New entry without one fails `pnpm changelog:check` with its file and line. `Improved`, `Fixed` and `Internal` entries are one line; a description there is allowed but rarely needed. `CHANGELOG.md` takes a New entry without a description, because the seeded history has only pull request titles and is never invented.
- `New`: something a user can do that they could not before. `Improved`: an existing feature works better or faster. `Fixed`: something that was broken works. `Internal`: a change nothing user-visible (refactor, tests, CI, docs, agent rules) — it is listed in Settings but never in the after-update dialog.
- One line per entry, in plain words a user would use, saying what they get, not how it was built. No file names, code identifiers, PR numbers, issue numbers or team talk. Inline `` `code` `` and `**bold**` render, in the line and the description; a leading `**Feature:**` names the area.
- A PR that changes several things lists each under its kind in the same fragment. A follow-up commit on an open PR edits that PR's fragment rather than adding a second one.

## What never to do in a feature PR

- Never edit `CHANGELOG.md`, and never write a version or a date anywhere: the version is cut by semantic-release only after the merge.
- Never rename or move another PR's fragment.

## How versions are resolved

- A fragment belongs to the lowest `v*` tag containing the commit that added it (`apps/ui/scripts/changelog.ts`, `resolveFragmentReleases`); its date is that tag's. Not tagged yet, a shallow clone or no git: it is "Not released yet".
- The renderer gets the parsed changelog at build time from the `virtual:geniro-changelog` module (`changelogPlugin`, registered in `electron.vite.config.ts`, `vitest.config.ts` and `.storybook/main.ts`). It is compiled into the bundle, so the app reads it offline and makes no network call for it.
- `CHANGELOG.md` holds released history, newest first, `## <x.y.z> — <YYYY-MM-DD>` per release with the same section headings and descriptions. Its format is strict: `pnpm changelog:check` and the `scripts/changelog.spec.ts` suite parse it and every fragment, and a malformed line fails CI with its file and line.

## Folding

`pnpm changelog:fold` moves every released fragment into `CHANGELOG.md` under its version, descriptions included, and deletes it; unreleased fragments stay. It is deterministic and idempotent, and runs in a pull request of its own (`docs(changelog): fold released fragments`), never inside a feature PR, so parallel PRs never touch the same lines. The app does not depend on it: an unfolded fragment already shows under its release.

## The app side

- "What's new" opens once per update in a packaged build (`renderer/changelog/use-whats-new.ts` over `planWhatsNew` in `shared/changelog.ts`) with every release after `Settings.lastSeenChangelogVersion` up to the running version, Internal left out: the range from the last seen version to the running one on top, then every change as one list per kind, each tagged with its release and its description under it (`components/changelog-digest.tsx`). It fills the window but for a margin and reads the version from the running process (`getStatus().appVersion`), never from the update state, whose `currentVersion` names a staged release once an update waits for the restart. Closing it records the running version. A fresh install that has not finished onboarding, a downgrade, or releases with only Internal entries record it without opening anything; a profile with no record yet sees only the running version's notes. An unpackaged build neither opens it nor writes the key.
- Settings → What's new (`settings/changelog.tsx`) shows the whole changelog with search (lines and descriptions), a kind filter and a jump to any version side by side, and the newest releases first behind Show all.
