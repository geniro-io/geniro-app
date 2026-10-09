import { RevealCallBlockContext, RevealCallContext } from './call-block';
import {
  type CalleeContextResolver,
  CalleeContextResolverContext,
} from './call-context';
import {
  type CallMessageChannel,
  CallMessageChannelContext,
} from './call-message-box';
import {
  type ChatMetricsLoader,
  ChatMetricsLoaderContext,
} from './chat-metrics';
import { CliLoginContext, type SignInResolver } from './cli-login-context';
import {
  DelegatesOutContext,
  RunActivityContext,
  RunSettledContext,
} from './live-row';
import {
  type LocalImageLoader,
  LocalImageLoaderContext,
} from './local-image-loader';
import {
  type AttachmentLoader,
  AttachmentLoaderContext,
} from './message-attachments';
import {
  type ArtifactUrlBuilder,
  ArtifactUrlContext,
} from './published-artifact';
import { RetryContext } from './retry-context';
import { SubagentDetailContext } from './subagent-context';
import { ThreadUiMemoryContext } from './thread-ui-memory';
import { CollapseToolStepsContext } from './tool-group';
import type { RunSettleAt, SubagentBlockEntry } from './transcript-groups';
import { CardBackedRequestsContext } from './transcript-item';
import { type TurnDuration, TurnDurationContext } from './turn-duration';

/**
 * The six values only a transcript row reads: the tool-step fold, the run's
 * activity phrase, turn durations, and the call-block reveal and detail handlers.
 * {@link ChatProviders} and {@link TranscriptContexts} both take them from here,
 * so the two cannot describe one value two ways.
 */
export interface TranscriptValues {
  /** Whether a turn's tool rows start folded — see `CollapseToolStepsContext`. */
  collapseToolSteps?: boolean;
  /** What the run is doing, for its live rows — see `RunActivityContext`. */
  runActivity?: string | null;
  /** How long each turn worked — see `TurnDurationContext`. */
  turnDurations?: ReadonlyMap<string, TurnDuration>;
  /**
   * Jump to a call block's card. Null on a surface with no transcript scroller
   * to jump within — see `RevealCallBlockContext`.
   */
  revealCallBlock?: ((cardId: string) => void) | null;
  /** The same jump addressed by call id — see `RevealCallContext`. */
  revealCall?: ((callId: string) => (() => void) | null) | null;
  /**
   * Open a sub-agent's detail. Null on a surface with no detail dialog — see
   * `SubagentDetailContext`.
   */
  openSubagentDetail?: ((block: SubagentBlockEntry) => void) | null;
}

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
 *
 * The transcript-level values are here for the same reason, and each is provided
 * only where it is passed (see `TranscriptContexts`): the chat screen passes
 * them around its transcript alone, and the workflow dock for its whole surface.
 */
export function ChatProviders({
  signIn,
  retry,
  callContext,
  callChannel,
  artifactUrl,
  threadId,
  runSettledAt,
  delegatesOut,
  collapseToolSteps,
  runActivity,
  turnDurations,
  revealCallBlock,
  revealCall,
  openSubagentDetail,
  loadAttachment = null,
  cardBacked,
  loadImage,
  loadMetrics,
  children,
}: TranscriptValues & {
  /**
   * The open run, whose folds every surface below remembers — see
   * `ThreadUiMemoryContext`. Here for the reason this component exists: the
   * agents panel, the shelf and the transcript are all inside it, and a new
   * provider around `Chats.tsx`'s tree would re-indent all of it.
   */
  threadId: string | null;
  /**
   * When the open run stopped, or null while it has not — see
   * `RunSettledContext`. Every transcript row reads it, so it is provided here
   * for both the chat screen and the workflow dock.
   */
  runSettledAt: RunSettleAt;
  /** How many of the run's delegates still report out — see `DelegatesOutContext`. */
  delegatesOut: number | null;
  /** Which sign-in cures a given row's failure — see `SignInResolver`. */
  signIn: SignInResolver | null;
  retry: (() => void) | null;
  /**
   * How a call block resolves its callee's context window while the call is
   * still open — see `CalleeContextResolverContext`. Provided HERE rather than
   * around the transcript itself because a call block is rendered from three
   * separate subtrees (the transcript, the sub-agent detail dialog, and the
   * workflow card), and this component wraps all of them.
   */
  callContext: CalleeContextResolver | null;
  /** The direct line to a running call's callee — see `CallMessageBox`. */
  callChannel: CallMessageChannel | null;
  /**
   * How a published page is addressed on the daemon — see
   * `ArtifactUrlContext`. Here for this component's own reason and one more:
   * the transcript card, the popup and the agents panel all frame the same
   * artifact, and all three are inside this tree.
   */
  artifactUrl: ArtifactUrlBuilder | null;
  /** Read images attached to this conversation, including in the workflow dock. */
  loadAttachment?: AttachmentLoader | null;
  /**
   * The requests on this surface that have a card — see
   * `CardBackedRequestsContext`. Provided only where passed (see `PassedContexts`).
   */
  cardBacked?: ReadonlySet<string>;
  /** How a local picture is read — see `LocalImageLoaderContext`. Provided only where passed. */
  loadImage?: LocalImageLoader | null;
  /** How a chat's context readout is read — see `ChatMetricsLoaderContext`. Provided only where passed. */
  loadMetrics?: ChatMetricsLoader;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <CliLoginContext.Provider value={signIn}>
      <RetryContext.Provider value={retry}>
        <CalleeContextResolverContext.Provider value={callContext}>
          <CallMessageChannelContext.Provider value={callChannel}>
            <ArtifactUrlContext.Provider value={artifactUrl}>
              <ThreadUiMemoryContext.Provider value={threadId}>
                <AttachmentLoaderContext.Provider value={loadAttachment}>
                  <TranscriptContexts
                    collapseToolSteps={collapseToolSteps}
                    runActivity={runActivity}
                    turnDurations={turnDurations}
                    revealCallBlock={revealCallBlock}
                    revealCall={revealCall}
                    openSubagentDetail={openSubagentDetail}>
                    <RunSettledContext.Provider value={runSettledAt}>
                      <DelegatesOutContext.Provider value={delegatesOut}>
                        <PassedContexts
                          cardBacked={cardBacked}
                          loadImage={loadImage}
                          loadMetrics={loadMetrics}>
                          {children}
                        </PassedContexts>
                      </DelegatesOutContext.Provider>
                    </RunSettledContext.Provider>
                  </TranscriptContexts>
                </AttachmentLoaderContext.Provider>
              </ThreadUiMemoryContext.Provider>
            </ArtifactUrlContext.Provider>
          </CallMessageChannelContext.Provider>
        </CalleeContextResolverContext.Provider>
      </RetryContext.Provider>
    </CliLoginContext.Provider>
  );
}

/**
 * The values only a transcript row reads: the tool-step fold setting, the run's
 * activity phrase, turn durations, and the call-block reveal and detail
 * handlers.
 *
 * A value is provided only where it is passed. The chat screen passes them
 * around its transcript alone, so the agents panel and the sub-agent dialog keep
 * each context's default. The workflow dock passes all of them for its whole
 * surface.
 */
export function TranscriptContexts({
  collapseToolSteps,
  runActivity,
  turnDurations,
  revealCallBlock,
  revealCall,
  openSubagentDetail,
  children,
}: TranscriptValues & { children: React.ReactNode }): React.JSX.Element {
  let content = children;
  if (openSubagentDetail !== undefined) {
    content = (
      <SubagentDetailContext.Provider value={openSubagentDetail}>
        {content}
      </SubagentDetailContext.Provider>
    );
  }
  if (revealCall !== undefined) {
    content = (
      <RevealCallContext.Provider value={revealCall}>
        {content}
      </RevealCallContext.Provider>
    );
  }
  if (revealCallBlock !== undefined) {
    content = (
      <RevealCallBlockContext.Provider value={revealCallBlock}>
        {content}
      </RevealCallBlockContext.Provider>
    );
  }
  if (turnDurations !== undefined) {
    content = (
      <TurnDurationContext.Provider value={turnDurations}>
        {content}
      </TurnDurationContext.Provider>
    );
  }
  if (runActivity !== undefined) {
    content = (
      <RunActivityContext.Provider value={runActivity}>
        {content}
      </RunActivityContext.Provider>
    );
  }
  if (collapseToolSteps !== undefined) {
    content = (
      <CollapseToolStepsContext.Provider value={collapseToolSteps}>
        {content}
      </CollapseToolStepsContext.Provider>
    );
  }
  return <>{content}</>;
}

/**
 * The readers a surface provides only when it has them: the workflow dock's card
 * and picture readers and its context readout. A value that is not passed is not
 * provided at all, so whatever encloses this component still answers — the chat
 * screen provides its own readers beneath {@link ChatProviders}.
 */
function PassedContexts({
  cardBacked,
  loadImage,
  loadMetrics,
  children,
}: {
  cardBacked?: ReadonlySet<string>;
  loadImage?: LocalImageLoader | null;
  loadMetrics?: ChatMetricsLoader;
  children: React.ReactNode;
}): React.JSX.Element {
  let content = children;
  if (cardBacked !== undefined) {
    content = (
      <CardBackedRequestsContext.Provider value={cardBacked}>
        {content}
      </CardBackedRequestsContext.Provider>
    );
  }
  if (loadImage !== undefined) {
    content = (
      <LocalImageLoaderContext.Provider value={loadImage}>
        {content}
      </LocalImageLoaderContext.Provider>
    );
  }
  if (loadMetrics !== undefined) {
    content = (
      <ChatMetricsLoaderContext.Provider value={loadMetrics}>
        {content}
      </ChatMetricsLoaderContext.Provider>
    );
  }
  return <>{content}</>;
}
