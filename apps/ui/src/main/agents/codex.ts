import type { CliAgentDescriptor } from './agent-descriptor';

/** What the main process knows about `codex` (OpenAI Codex CLI). */
export const CODEX_DESCRIPTOR: CliAgentDescriptor = {
  kind: 'codex',
  // Read out of the 0.157.1 binary's own string table: the three credentials
  // it authenticates with, its config home (which account a run is) and its
  // state directory. A GitHub token it uses for its cloud tasks rides along,
  // since it is a credential all the same.
  ownEnvKeys: [
    'OPENAI_API_KEY',
    'CODEX_API_KEY',
    'CODEX_ACCESS_TOKEN',
    'CODEX_GITHUB_PERSONAL_ACCESS_TOKEN',
    'CODEX_HOME',
    'CODEX_SQLITE_HOME',
  ],
  // `codex login status` offers no structured form, so its two answers are
  // read by exit code AND wording, each of which must agree: measured on
  // 0.157.1, `Logged in using ChatGPT` exits 0 and `Not logged in` (under an
  // empty CODEX_HOME) exits 1 — both on STDERR, with stdout empty. Anything
  // else is not an answer.
  //
  // The account lives INSIDE the config home, so a named configuration is probed
  // by pointing the CLI at it (measured on 0.157.1: under an empty `CODEX_HOME`
  // it answers `Not logged in`, exit 1, while the default profile answers
  // `Logged in using ChatGPT`; a home that does not exist is an error, which
  // reads as unknown rather than as signed out).
  loginProbe: {
    args: ['login', 'status'],
    configDirEnv: 'CODEX_HOME',
    read: ({ stderr, exitCode }) => {
      const text = stderr.trim().toLowerCase();
      if (exitCode === 0 && text.startsWith('logged in')) {
        return true;
      }
      if (exitCode !== 0 && text.startsWith('not logged in')) {
        return false;
      }
      return null;
    },
  },
  // `codex update` updates in one step; its `--help` offers no check-only
  // flag, so there is nothing to ask short of installing.
  latestProbe: {
    unavailableReason:
      'codex has no check of its own — it looks for a new version only while installing one.',
  },
  updateArgs: ['update'],
};
