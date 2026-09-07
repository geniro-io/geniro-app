import {
  type CalleeContextResolver,
  CalleeContextResolverContext,
} from './call-context';
import { CliLoginContext } from './cli-login-context';
import { RetryContext } from './retry-context';

/**
 * What a transcript row reaches for without being handed it as a prop.
 *
 * One component rather than nested providers at the call site, and the reason
 * is the diff rather than the runtime: `Chats.tsx`'s returned tree is ~1,900
 * lines, so each further provider wrapped around it re-indents every one of
 * them and buries the change in a file nobody can then review. MEASURED when
 * the third value below was added by nesting instead: 1,663 changed lines, of
 * which 80 were the change. A fourth belongs here too.
 *
 * It began as the two things a row can DO about a failed turn, which is why the
 * name was `ChatActionProviders`; `callContext` is data rather than an action,
 * and the widened name is what the whole set has in common — a row deep inside
 * a memoized tree needing something only `Chats` can compute.
 */
export function ChatProviders({
  signIn,
  retry,
  callContext,
  children,
}: {
  signIn: (() => void) | null;
  retry: (() => void) | null;
  /**
   * How a call block resolves its callee's context window while the call is
   * still open — see `CalleeContextResolverContext`. Provided HERE rather than
   * around the transcript itself because a call block is rendered from three
   * separate subtrees (the transcript, the sub-agent detail dialog, and the
   * workflow card), and this component wraps all of them.
   */
  callContext: CalleeContextResolver | null;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <CliLoginContext.Provider value={signIn}>
      <RetryContext.Provider value={retry}>
        <CalleeContextResolverContext.Provider value={callContext}>
          {children}
        </CalleeContextResolverContext.Provider>
      </RetryContext.Provider>
    </CliLoginContext.Provider>
  );
}
