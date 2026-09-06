import { CliLoginContext } from './cli-login-context';
import { RetryContext } from './retry-context';

/**
 * The two things a transcript row can DO about a failed turn, provided
 * together.
 *
 * One component rather than nested providers at the call site, and the reason
 * is the diff rather than the runtime: `Chats.tsx`'s returned tree is ~1,900
 * lines, so each further provider wrapped around it re-indents every one of
 * them and buries the change in a file nobody can then review. A third action
 * belongs here too.
 */
export function ChatActionProviders({
  signIn,
  retry,
  children,
}: {
  signIn: (() => void) | null;
  retry: (() => void) | null;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <CliLoginContext.Provider value={signIn}>
      <RetryContext.Provider value={retry}>{children}</RetryContext.Provider>
    </CliLoginContext.Provider>
  );
}
