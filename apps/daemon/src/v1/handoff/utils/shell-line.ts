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
export function shellLine(command: string, args: string[]): string {
  return [command, ...args].map(quote).join(' ');
}
