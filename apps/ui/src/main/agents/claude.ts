import { type CliAgentDescriptor, jsonBooleanField } from './agent-descriptor';

/** What the main process knows about `claude` (Claude Code). */
export const CLAUDE_DESCRIPTOR: CliAgentDescriptor = {
  kind: 'claude',
  ownEnvKeys: [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_CUSTOM_HEADERS',
    'CLAUDE_CODE_OAUTH_TOKEN',
    // Not credentials, but the same class of leak: an OUTER Claude Code
    // session, a chosen profile and a feature switch, none of which another
    // CLI's probe has any business holding.
    'CLAUDE_CODE_SESSION_ID',
    'CLAUDE_CONFIG_DIR',
    'CLAUDE_CODE_ENABLE_CFC',
  ],
  // `claude auth status --json` answers `{"loggedIn": true, "authMethod":
  // "claude.ai", …}` and, under an empty `CLAUDE_CONFIG_DIR`, `{"loggedIn":
  // false, …}` — probe-verified on 2.1.227, exit 0 for BOTH answers. `--json`
  // is passed although it is documented as the default, so a default flip
  // cannot silently hand the reader prose.
  loginProbe: {
    args: ['auth', 'status', '--json'],
    read: jsonBooleanField('loggedIn'),
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
  // It was the only CLI with a config directory (`CLAUDE_CONFIG_DIR`) while
  // the app remembered one directory for every agent.
  ownsUnscopedConfigDirs: true,
};
