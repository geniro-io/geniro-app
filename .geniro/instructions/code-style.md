# Custom Instructions

Cross-cutting code-style rules, loaded at every Geniro code-writing and
code-review step.

## Rules

- **Sweep your own comments as the last step before delivering** — a separate
  pass, re-reading each one you added the way a reviewer would and cutting what
  fails the bars below. Judging a comment while writing it is the wrong moment:
  the rationale is loudest in your head exactly then, and twelve lines of it
  read as noise a week later.
- **A comment carries the non-obvious why; the code carries the what.** Delete
  one that restates the line under it (`/** What the user calls it. */` over
  `name: string`) — it costs a reader a beat and goes stale on the next edit.
- **Keep authoring and review history out of the source.** "adding the cap
  per-field is what let this slip through", "learned the hard way", "the bug
  round 3 caught" — that belongs in the commit message or the PR, where it is
  dated and attributable; in a comment it is a changelog the reader has to
  decode.
- **Keep the comment that would cost real work to re-derive** — a non-obvious
  invariant, an ordering that looks arbitrary (a TDZ-forced declaration
  position), a guard against argument injection, or why the obvious alternative
  is wrong. Length is not the test; three lines that save an hour stay.

## Constraints

- (none — add cross-cutting hard limits here)
