import {
  type CliAgentDescriptor,
  jsonBooleanField,
  parseJsonObject,
} from './agent-descriptor';

/** What the main process knows about `cursor-agent`. */
export const CURSOR_AGENT_DESCRIPTOR: CliAgentDescriptor = {
  kind: 'cursor-agent',
  ownEnvKeys: ['CURSOR_API_KEY'],
  // `cursor-agent status --format json` returns `{"isAuthenticated": bool, …}`
  // (verified on 2026.08.11-e8db854). Its human output has a THIRD state,
  // `Partially authenticated (missing refresh token)`, that matched neither
  // wording — a half-expired session read as ready while turns failed.
  loginProbe: {
    args: ['status', '--format', 'json'],
    read: jsonBooleanField('isAuthenticated'),
  },
  // `about --format json` answers `{"latestStatus": …, "latestVersion": …}`
  // (measured 2026-09-03 on 2026.08.31-4057e58). Its bundle switches on exactly
  // `up_to_date` and `update_available`, so those are the only values it
  // vouches for and anything else reads as unknown.
  latestProbe: {
    args: ['about', '--format', 'json'],
    read: (stdout) => {
      const row = parseJsonObject(stdout);
      const status = row?.['latestStatus'];
      const latest = row?.['latestVersion'];
      return {
        available:
          status === 'update_available'
            ? true
            : status === 'up_to_date'
              ? false
              : null,
        latestVersion:
          typeof latest === 'string' && latest.length > 0 ? latest : null,
      };
    },
  },
  updateArgs: ['update'],
};
