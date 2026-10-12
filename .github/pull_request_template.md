<!--
One template for every pull request — maintainers, contributors and AI agents
alike. Keep the headings; delete only the hint comments.

The PR TITLE becomes the commit on `main` and decides the release version, so
use the conventional format: `type(scope): subject`.
  Good: fix(ui): keep the composer focused after send
        feat(daemon): add a codex model picker
  Bad:  fix #123 / update stuff / WIP

Open it as a draft while it is still in progress. See CONTRIBUTING.md.
-->

## Why

<!-- The problem this solves, or what was asked for, in a sentence or two. Link the issue. -->

Closes #

## What changed

<!-- The change itself, and why this approach. Point at anything a reviewer should look at closely. -->

## How it was verified

<!-- What you ran and what you checked by hand. For a UI change, add before/after screenshots or a short recording. -->

## Not in this PR

<!-- Optional: what you deliberately left out, known limits, follow-ups. Write "nothing" if there is none. -->

## AI assistance

<!-- Name the agent that wrote some or all of this (Claude Code, Codex, Cursor, …), or write "none". -->

## Checklist

- [ ] `pnpm full-check` passes locally
- [ ] Tests cover the new or changed behaviour
- [ ] I've read the whole diff and can explain every change in it
- [ ] Docs (`README.md`, `docs/`, `AGENTS.md`) are updated if behaviour changed
