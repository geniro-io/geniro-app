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
 * The values only a transcript row reads. {@link TranscriptContexts} provides
 * them: the chat screen around its transcript alone, the workflow dock (through
 * `ChatProviders`' `transcript`) around its whole surface.
 */
export interface TranscriptValues {
  /** Whether a turn's tool rows start folded — see `CollapseToolStepsContext`. */
  collapseToolSteps: boolean;
  /** What the run is doing, for its live rows — see `RunActivityContext`. */
  runActivity: string | null;
  /** How long each turn worked — see `TurnDurationContext`. */
  turnDurations: ReadonlyMap<string, TurnDuration>;
  /** Jump to a call block's card, or null with no scroller to jump within. */
  revealCallBlock: ((cardId: string) => void) | null;
  /** The same jump addressed by call id. */
  revealCall: ((callId: string) => (() => void) | null) | null;
  /** Open a sub-agent's detail, or null with no detail dialog. */
  openSubagentDetail: ((block: SubagentBlockEntry) => void) | null;
}

/**
 * The {@link TranscriptValues} plus the readers the chat screen provides
 * screen-wide on its own: what a surface that is ALL transcript (the workflow
 * dock) hands {@link ChatProviders} in one piece.
 */
export interface TranscriptSurface extends TranscriptValues {
  /** The requests that have a card — see `CardBackedRequestsContext`. */
  cardBacked: ReadonlySet<string>;
  /** How a local picture is read — see `LocalImageLoaderContext`. */
  loadImage: LocalImageLoader | null;
  /** How the context readout is read — see `ChatMetricsLoaderContext`. */
  loadMetrics: ChatMetricsLoader | null;
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
  transcript,
  loadAttachment = null,
  children,
}: {
  /**
   * The open run, whose folds every surface below remembers — see
   * `ThreadUiMemoryContext`. Here for the reason this component exists: the
   * agents panel, the shelf and the transcript are all inside it, and a new
   * provider around `Chats.tsx`'s tree would re-indent all of it.
   */
  threadId: string | null;
  /**
   * When the open run stopped, or null while it has not — see
   * `RunSettledContext`. The transcript, the shelf and the agents panel all
   * read it, so it is provided for the whole surface.
   */
  runSettledAt: RunSettleAt;
  /** How many of the run's delegates still report out — see `DelegatesOutContext`. */
  delegatesOut: number | null;
  /**
   * Everything a transcript row reads, for a surface that is ALL transcript
   * (the workflow dock). The chat screen leaves it out: it provides the
   * transcript values around its transcript alone, and the readers itself.
   */
  transcript?: TranscriptSurface;
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
                  <RunSettledContext.Provider value={runSettledAt}>
                    <DelegatesOutContext.Provider value={delegatesOut}>
                      {transcript === undefined ? (
                        children
                      ) : (
                        <SurfaceContexts {...transcript}>
                          {children}
                        </SurfaceContexts>
                      )}
                    </DelegatesOutContext.Provider>
                  </RunSettledContext.Provider>
                </AttachmentLoaderContext.Provider>
              </ThreadUiMemoryContext.Provider>
            </ArtifactUrlContext.Provider>
          </CallMessageChannelContext.Provider>
        </CalleeContextResolverContext.Provider>
      </RetryContext.Provider>
    </CliLoginContext.Provider>
  );
}

function SurfaceContexts({
  cardBacked,
  loadImage,
  loadMetrics,
  children,
  ...values
}: TranscriptSurface & { children: React.ReactNode }): React.JSX.Element {
  return (
    <CardBackedRequestsContext.Provider value={cardBacked}>
      <LocalImageLoaderContext.Provider value={loadImage}>
        <ChatMetricsLoaderContext.Provider value={loadMetrics}>
          <TranscriptContexts {...values}>{children}</TranscriptContexts>
        </ChatMetricsLoaderContext.Provider>
      </LocalImageLoaderContext.Provider>
    </CardBackedRequestsContext.Provider>
  );
}

/** Provides the {@link TranscriptValues} — see there for who passes them where. */
export function TranscriptContexts({
  collapseToolSteps,
  runActivity,
  turnDurations,
  revealCallBlock,
  revealCall,
  openSubagentDetail,
  children,
}: TranscriptValues & { children: React.ReactNode }): React.JSX.Element {
  return (
    <CollapseToolStepsContext.Provider value={collapseToolSteps}>
      <RunActivityContext.Provider value={runActivity}>
        <TurnDurationContext.Provider value={turnDurations}>
          <RevealCallBlockContext.Provider value={revealCallBlock}>
            <RevealCallContext.Provider value={revealCall}>
              <SubagentDetailContext.Provider value={openSubagentDetail}>
                {children}
              </SubagentDetailContext.Provider>
            </RevealCallContext.Provider>
          </RevealCallBlockContext.Provider>
        </TurnDurationContext.Provider>
      </RunActivityContext.Provider>
    </CollapseToolStepsContext.Provider>
  );
}
