import { Loader2, LogIn, LogOut } from 'lucide-react';

import { Button } from './ui/button';
import { cn } from './ui/utils';

/**
 * The ONE account action beside an account — whichever of the two the CLI's
 * own answer makes true. The agent cards and each named configuration both
 * draw it from here.
 *
 * `loggedIn === true` is the ONLY state that offers Sign out, and it never
 * offers Sign in: an action the user cannot need, in the place they look to
 * learn whether setup is finished, reads as an unfinished step. `null` offers
 * Sign in because that is the action which can only help — re-authenticating a
 * live account costs a re-auth the user can cancel, while signing OUT on an
 * unknown state could destroy a working session over a probe failure.
 *
 * With no handler for the verb its state calls for it renders NOTHING rather
 * than the other one: offering the wrong verb because the right one is
 * unavailable is how a control becomes a lie.
 *
 * Words beside the icon, never an icon alone — the two arrow-into-a-box glyphs
 * are mirror images, and two of them side by side read as two sign-in buttons.
 */
export function AccountButton({
  loggedIn,
  signingIn,
  busy = false,
  account,
  compact = false,
  onSignIn,
  onSignOut,
}: {
  /** What the CLI said: signed in, signed out, or not known. */
  loggedIn: boolean | null;
  /** This account's sign-in has been asked for and not yet answered. */
  signingIn: boolean;
  /**
   * ANOTHER sign-in on the screen owns the browser. Withheld rather than
   * hidden: a second challenge invalidates the first.
   */
  busy?: boolean;
  /** Names the account in the accessible name, where several sit together. */
  account?: string;
  /** The row-sized form, for a list of accounts rather than a card. */
  compact?: boolean;
  onSignIn?: () => void;
  onSignOut?: () => void;
}): React.JSX.Element | null {
  const size = compact ? 'h-7 gap-1 px-2 text-xs' : undefined;
  if (loggedIn === true) {
    return onSignOut ? (
      // GHOST, where its sign-in sibling is not. The weight tracks how likely
      // the user is to want it: signing out of a working CLI is rare and mildly
      // destructive, so it stays quiet rather than competing with the card.
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={cn('shrink-0 text-muted-foreground', size)}
        {...(account === undefined
          ? {}
          : {
              'aria-label': `Sign out of ${account}`,
              title: `${account} is signed in — press to sign out`,
            })}
        disabled={busy}
        onClick={onSignOut}>
        <LogOut aria-hidden="true" className="size-3.5 shrink-0" />
        Sign out
      </Button>
    ) : null;
  }
  return onSignIn ? (
    // The press is answered HERE. The panel that follows appears only once the
    // daemon has replied, and that reply is held until the CLI prints its URL,
    // seconds later — a button that did not change would sit unchanged while a
    // browser tab opens behind the window. Disabled as well as spinning: a
    // second press starts a second browser challenge that invalidates the
    // first.
    <Button
      type="button"
      variant={compact ? 'ghost' : 'outline'}
      size="sm"
      className={cn(
        'shrink-0',
        size,
        compact &&
          (loggedIn === false ? 'text-warning' : 'text-muted-foreground'),
      )}
      {...(account === undefined
        ? {}
        : {
            'aria-label': `Sign in to ${account}`,
            title:
              loggedIn === false
                ? `${account} is not signed in — press to sign in (opens your browser)`
                : `Sign in to ${account} — runs here and opens your browser`,
          })}
      disabled={signingIn || busy}
      onClick={onSignIn}>
      {signingIn ? (
        <Loader2
          aria-hidden="true"
          className="size-3.5 shrink-0 animate-spin"
        />
      ) : (
        <LogIn aria-hidden="true" className="size-3.5 shrink-0" />
      )}
      {signingIn ? 'Signing in…' : 'Sign in'}
    </Button>
  ) : null;
}
