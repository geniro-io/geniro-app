import type { ManagedCommandResult } from '../../agents/utils/managed-command';
import type { DestinationCommand, ShareDestination } from '../shares.types';
import { awsScope } from './share-destinations';

/**
 * How a destination's CLI is signed in to: the command that signs it in
 * again, the read-only command that tells whether it is signed in now, and
 * the output that means it is not.
 *
 * A destination with no profile has no sign-in: every failure it meets is an
 * ordinary failure, and nothing is ever offered to fix it by signing in.
 */
export interface ShareAuthProfile {
  /** The CLI's own name, shown as "sign-in required (<cli>)". */
  cli: string;
  /** What the sign-in button names: "Sign in to <label>". */
  label: string;
  login: DestinationCommand;
  /**
   * Answers exit 0 while signed in. Its stdout can be a live credential
   * (`gcloud auth print-access-token`), so it is run with stdout discarded.
   * Null for a custom destination, which has no read to try.
   */
  check: DestinationCommand | null;
  /** Lower-case substrings; any of them in a failed command's output means signed out. */
  patterns: readonly string[];
}

export type ShareFailureCause = 'auth' | 'other';

/**
 * gcloud's words for a lapsed or missing login, as `googlecloudsdk` writes
 * them (`core/credentials/exceptions.py`, `google_auth_credentials.py`) and
 * as SDK 536 printed them for a configuration with no account and for an
 * account whose credentials were revoked.
 */
const GCLOUD_PATTERNS = [
  'does not have any valid credentials',
  'you do not currently have an active account selected',
  'reauthentication failed',
  'reauthentication required',
  'reauth is required',
  'cannot prompt during non-interactive execution',
  'there was a problem refreshing your current auth tokens',
  'there was a problem refreshing auth tokens for account',
  'there was a problem reauthenticating while refreshing',
  'invalid_grant',
  'no credentialed accounts',
  'gcloud auth login',
] as const;

/** The aws CLI's words for an expired or missing login (botocore `exceptions.py`, `tokens.py`, STS error codes). */
const AWS_PATTERNS = [
  'expiredtoken',
  'token has expired',
  'the sso session associated with this profile has expired',
  'error loading sso token',
  'unable to locate credentials',
  'unable to locate authorization token',
  'mfa token required',
  'invalidtoken',
  'invalidclienttokenid',
] as const;

/**
 * Words of a connection that never reached the server. They outrank every
 * sign-in pattern: gcloud wraps a DNS failure during a token refresh in the
 * same "problem refreshing your current auth tokens … gcloud auth login"
 * error a lapsed login gets (`core/credentials/store.py`,
 * `httplib2.ServerNotFoundError`), and signing in again fixes no network.
 */
const NETWORK_MARKERS = [
  'unable to find the server',
  'max retries exceeded',
  'connection refused',
  'connection reset',
  'network is unreachable',
  'nodename nor servname',
  'name or service not known',
  'temporary failure in name resolution',
  'could not connect to the endpoint url',
  'connect timeout',
  'read timed out',
] as const;

/**
 * The sign-in a destination's CLI has, or null when it has none.
 *
 * `gcs` and `s3` use gcloud's and aws's own. A custom command uses the
 * `signIn` the user gave it; without a login command of its own, a program
 * named `gcloud` or `aws` borrows that CLI's, keeping the flags that pick
 * which account it runs as.
 */
export function authProfileOf(
  destination: ShareDestination,
): ShareAuthProfile | null {
  switch (destination.kind) {
    case 'gcs':
      return gcloudProfile([]);
    case 's3':
      return awsProfile(awsScope(destination));
    case 'command': {
      const program = destination.upload[0] ?? '';
      const inferred = inferredProfile(program, destination.upload.slice(1));
      const signIn = destination.signIn;
      const patterns = (signIn?.patterns ?? []).map((p) => p.toLowerCase());
      const [command, ...args] = signIn?.login ?? [];
      if (command !== undefined) {
        return {
          cli: inferred?.cli ?? basename(command),
          label: inferred?.label ?? destination.name,
          login: { command, args },
          check: inferred?.check ?? null,
          patterns: [...(inferred?.patterns ?? []), ...patterns],
        };
      }
      return inferred === null
        ? null
        : { ...inferred, patterns: [...inferred.patterns, ...patterns] };
    }
  }
}

/**
 * Whether a failed destination command failed because its CLI is signed
 * out. Only the profile's own words decide: a command that could not start
 * or ran out of time is never a sign-in problem, and neither is any failure
 * of a destination with no profile.
 */
export function classifyShareFailure(
  profile: ShareAuthProfile | null,
  result: Pick<
    ManagedCommandResult,
    'code' | 'stdout' | 'stderr' | 'timedOut' | 'spawnError'
  >,
): ShareFailureCause {
  if (
    profile === null ||
    result.code === 0 ||
    result.spawnError !== undefined ||
    result.timedOut
  ) {
    return 'other';
  }
  const text = `${result.stderr}\n${result.stdout}`.toLowerCase();
  if (NETWORK_MARKERS.some((marker) => text.includes(marker))) {
    return 'other';
  }
  return profile.patterns.some((pattern) => text.includes(pattern))
    ? 'auth'
    : 'other';
}

function gcloudProfile(scope: string[]): ShareAuthProfile {
  return {
    cli: 'gcloud',
    label: 'Google Cloud',
    login: { command: 'gcloud', args: ['auth', 'login', ...scope] },
    check: {
      command: 'gcloud',
      args: ['auth', 'print-access-token', ...scope],
    },
    patterns: GCLOUD_PATTERNS,
  };
}

function awsProfile(scope: string[]): ShareAuthProfile {
  return {
    cli: 'aws',
    label: 'AWS',
    login: { command: 'aws', args: ['sso', 'login', ...scope] },
    check: { command: 'aws', args: ['sts', 'get-caller-identity', ...scope] },
    patterns: AWS_PATTERNS,
  };
}

function inferredProfile(
  program: string,
  args: string[],
): ShareAuthProfile | null {
  switch (basename(program)) {
    case 'gcloud':
      return gcloudProfile(flagsOf(args, ['--account', '--configuration']));
    case 'aws':
      return awsProfile(flagsOf(args, ['--profile']));
    default:
      return null;
  }
}

/** The given flags and their values, in either `--flag value` or `--flag=value` form. */
function flagsOf(args: string[], flags: readonly string[]): string[] {
  const kept: string[] = [];
  args.forEach((arg, index) => {
    const flag = flags.find(
      (name) => arg === name || arg.startsWith(`${name}=`),
    );
    if (flag === undefined) {
      return;
    }
    if (arg !== flag) {
      kept.push(arg);
      return;
    }
    const value = args[index + 1];
    if (value !== undefined) {
      kept.push(arg, value);
    }
  });
  return kept;
}

function basename(path: string): string {
  return path.split('/').pop() ?? path;
}
