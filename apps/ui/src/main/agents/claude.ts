import { type CliAgentDescriptor, jsonBooleanField } from './agent-descriptor';

/** What the main process knows about `claude` (Claude Code). */
export const CLAUDE_DESCRIPTOR: CliAgentDescriptor = {
  kind: 'claude',
  ownEnvKeys: [
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_SMALL_FAST_MODEL',
    'CLAUDE_CODE_SUBAGENT_MODEL',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_CUSTOM_HEADERS',
    'CLAUDE_CODE_OAUTH_TOKEN',
    // The rest of what the 2.1.280 bundle authenticates from: a long-lived
    // OAuth REFRESH token, a Bedrock bearer token, both Foundry credentials and
    // the Anthropic-on-AWS key. Each reached every other CLI's probe until named.
    'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
    'AWS_BEARER_TOKEN_BEDROCK',
    'ANTHROPIC_FOUNDRY_API_KEY',
    'ANTHROPIC_FOUNDRY_AUTH_TOKEN',
    'ANTHROPIC_AWS_API_KEY',
    // Not credentials, but the same class of leak: an OUTER Claude Code
    // session, a chosen profile and a feature switch, none of which another
    // CLI's probe has any business holding.
    'CLAUDE_CODE_SESSION_ID',
    'CLAUDE_CONFIG_DIR',
    'CLAUDE_CODE_ENABLE_CFC',
  ],
  // `claude auth status --json` answers `{"loggedIn": true, "authMethod":
  // "claude.ai", …}` and, under an empty `CLAUDE_CONFIG_DIR`, `{"loggedIn":
  // false, …}` — probe-verified on 2.1.227 (exit 0 for BOTH answers; 2.1.280
  // exits 1 for the signed-out one, which the reader does not mind). `--json`
  // is passed although it is documented as the default, so a default flip
  // cannot silently hand the reader prose. The account lives INSIDE the config
  // directory, so a named configuration is probed by pointing the CLI at it.
  loginProbe: {
    args: ['auth', 'status', '--json'],
    read: jsonBooleanField('loggedIn'),
    configDirEnv: 'CLAUDE_CONFIG_DIR',
  },
  // Measured three ways on 2.1.251: `claude update` checks and installs in one
  // step with no `--check`, `~/.claude.json` caches no latest-version figure,
  // and `claude doctor` reports the install rather than what is available. The
  // binary does carry its release host — deliberately not read: fetching a
  // vendor's manifest would be an outbound call of geniro's own.
  latestProbe: {
    unavailableReason:
      'claude has no check of its own — it looks for a new version only while installing one.',
  },
  // "Check for updates and install if available" — its own `--help`.
  updateArgs: ['update'],
  // The native installer (read 2026-10-09): downloads the build into
  // `~/.claude/downloads`, then `claude install` links it into `~/.local/bin`.
  // It refuses to run under sudo, and never asks anything.
  installer: { url: 'https://claude.ai/install.sh', shell: '/bin/bash' },
  // It was the only CLI with a config directory (`CLAUDE_CONFIG_DIR`) while
  // the app remembered one directory for every agent.
  ownsUnscopedConfigDirs: true,
};
