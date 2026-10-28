# Contributing to Geniro

Thanks for your interest in improving Geniro. Bug reports, ideas and pull
requests are all welcome.

Everyone taking part is expected to follow our
[Code of Conduct](CODE_OF_CONDUCT.md).

## Reporting a bug or asking for a feature

[Open an issue](https://github.com/geniro-io/geniro-app/issues/new/choose) and
pick the bug report or feature request form — it asks for what we need, such as
your Geniro and macOS versions, the agent CLI involved, and the debug log
(⌥⌘L in the app).

For something larger than a small fix, please open an issue first so we can
agree on the approach before you spend time on it.

## Sending a pull request

You don't need to be invited to the repository — fork it and open a pull
request from your fork.

1. Fork `geniro-io/geniro-app` and create a branch from `main`.
2. Set up the project as described in the
   [development guide](docs/development.md). Geniro needs macOS, Node.js 24.15+
   and pnpm 11, and the native rebuild step is required:

   ```bash
   pnpm install
   pnpm rebuild:native
   pnpm dev
   ```

3. Make your change. Keep the pull request focused on one thing. If it adds a
   feature or changes how one behaves for users, update `README.md` in the
   same pull request.
4. Run the full check before pushing — CI runs the same gates:

   ```bash
   pnpm full-check
   ```

   `full-check` runs `lint:fix`, while CI runs `lint` without fixing, so commit
   any fixes it made.

5. Open the pull request against `main` and describe what changed and why.
   For a UI change, a screenshot helps a lot.

The first time you contribute, a maintainer has to approve the CI run before
it starts. A pull request is merged once CI passes and it has been reviewed.

## Conventions

- **Commit messages and PR titles are [conventional](https://www.conventionalcommits.org/)**
  — `type(scope): subject`, e.g. `fix(ui): keep the composer focused after send`.
  A git hook checks commit messages, and `pnpm commit` will walk you through
  one. Pull requests should be squash-merged, so the PR title becomes the
  commit on `main` and decides the next release version; a merge commit makes
  semantic-release read the branch's own commit messages instead.
- **Never commit with `--no-verify`.** The hooks are part of the checks.
- **Tests** live next to the code as `*.spec.ts(x)`. A change in behaviour
  comes with a test that fails without it.
- **Project conventions** — module layout, the design system, how agent
  adapters and MCP tools are structured — are written down in
  [`AGENTS.md`](AGENTS.md), `apps/daemon/AGENTS.md`, `apps/ui/AGENTS.md`,
  `apps/ui/src/main/AGENTS.md` (the Electron main process) and the rules under
  `.claude/rules/`. Please read the parts that cover the code you're touching.
- **Local-first.** Geniro runs entirely on the user's machine. A change that
  adds a cloud service, telemetry or a stored credential will not be accepted;
  see _Constraints_ in `AGENTS.md`.

## Using an AI coding agent

Pull requests and issues written with Claude Code, Codex, Cursor or any other
agent are welcome. The repository is set up for them: [`AGENTS.md`](AGENTS.md)
(which Claude Code reads through `CLAUDE.md`) tells an agent how this codebase
is built and, in _Issues and pull requests_, how to file an issue and open a
pull request here — the issue headings, the PR title format, the checks to run.
Point your agent at it. Codex, Cursor, GitHub Copilot and most other agents
read `AGENTS.md` on their own. All the checks run on Linux too, so an agent
in a cloud sandbox can run `pnpm full-check` before it opens the pull request.

You are still the author, and one rule matters more than the rest: **you must
understand the change you submit.** Read the diff, be able to explain what it
does and why without asking the agent, and answer review comments yourself.
Say which agent helped under _AI assistance_ in the PR description. Pull
requests that look like unread agent output will be closed.

## License

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE), the same license as the project.
