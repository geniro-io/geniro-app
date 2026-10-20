import { redactSecrets } from '../../diagnostics/utils/redact';

/**
 * A shell word `NAME=value` wherever a word starts — in front of a command,
 * after `&&` / `;` / `|`, behind `env` or `export` — with its whole value: quoted
 * runs, escapes, `$(…)` and backtick substitutions as one value.
 */
const ENV_ASSIGNMENT =
  /(^|[\s;&|(])([A-Za-z_][A-Za-z0-9_]*)=(?:'[^']*'|"(?:[^"\\]|\\.)*"|`[^`]*`|\$\([^)]*\)|\\.|[^\s'"`\\;&|()])*/g;

/**
 * A command line as it may be shown off its own conversation — to another
 * agent's provider, or on a card: every env assignment's value as `…`, then
 * registered secrets masked. An assignment is where an unregistered token sits
 * (`GITHUB_TOKEN=… pnpm dev`); its name still says what was set. Assignments
 * go first, so a mask's own words are never cut as a value.
 */
export function maskedCommand(command: string): string {
  return redactSecrets(command.replace(ENV_ASSIGNMENT, '$1$2=…'));
}
