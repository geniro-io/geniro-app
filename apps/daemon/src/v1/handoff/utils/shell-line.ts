/**
 * Characters a POSIX shell would act on rather than pass through. Anything
 * outside this set is safe bare, which keeps the common case — a flag and a
 * UUID — readable instead of drowned in quotes.
 */
const SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * One argument, quoted only if the shell would otherwise reinterpret it.
 *
 * Single quotes, because inside them a shell expands nothing at all; an
 * embedded quote is closed, escaped and reopened (`'\''`), which is the only
 * form that survives every POSIX shell.
 */
function quote(arg: string): string {
  if (arg.length === 0) {
    return "''";
  }
  return SAFE.test(arg) ? arg : `'${arg.split("'").join(`'\\''`)}'`;
}

/**
 * The invocation as ONE line a user can paste into their own terminal.
 *
 * This exists because the button is not the only way out: the same string is
 * shown on hover and copyable, so someone using a terminal geniro cannot launch
 * — a remote host, a tmux pane they already have open — is never stuck. Built
 * from the SAME command and args the button runs, so the two cannot describe
 * different things.
 */
export function shellLine(
  command: string,
  args: string[],
  env: Record<string, string> = {},
): string {
  // `NAME=value cmd …` — a prefix assignment, which every POSIX shell applies
  // to that command alone. Not `export`: the line is meant to be pasted, and an
  // export would leave the variable set in the user's own shell afterwards,
  // silently re-pointing every later CLI invocation in that window at a profile
  // they chose once for one conversation.
  //
  // Sorted, so the same target always renders the same line — a set has no
  // order of its own, and a line that reshuffles between reads looks like a
  // different command.
  //
  // Only the VALUE is quoted, and the assignment is not re-quoted with the
  // rest: `NAME='/two words'` already contains quotes, so passing it back
  // through `quote` would wrap the whole thing and the shell would look for a
  // command literally named `NAME=/two words`.
  const assignments = Object.entries(env)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `${name}=${quote(value)}`);
  return [...assignments, ...[command, ...args].map(quote)].join(' ');
}
