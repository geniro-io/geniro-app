import { ChevronDown, Trash2 } from 'lucide-react';

import type { DaemonHandle } from '../../shared/contracts';
import { PanelResizeHandle, usePanelWidth } from '../components/panel-resize';
import { Button } from '../components/ui/button';
import { useLatestCallback } from '../components/use-latest-callback';
import type { DaemonClient } from '../daemon-client';
import { Chats } from './Chats';
import type { HostedThread } from './hosted-thread';

/**
 * A conversation docked under a page — the team builder's, a project page's:
 * the chat screen itself drawing one thread (`Chats` with `hosted`), in an
 * `<aside>` with a resize handle like the terminal panel, with Start over and
 * Hide in its header.
 *
 * Once opened it stays MOUNTED while its page holds that subject and is only
 * HIDDEN when closed: unmounted, a turn still running when the dock was closed
 * would take its `working` report and its settle with it, so the page's
 * autosave would stay suspended and the agent's change would never be read
 * back.
 */
export function HostedChatDock({
  thread,
  label,
  panelName,
  storageKey,
  handle,
  client,
  hidden = false,
  active = true,
  onClose,
}: {
  thread: Omit<HostedThread, 'headerActions'>;
  /** What the dock is called to assistive tech, e.g. "Change Billing with chat". */
  label: string;
  /** What its Hide and resize controls call it, e.g. "team chat panel". */
  panelName: string;
  /** Where the dock's height is remembered. */
  storageKey: string;
  handle: DaemonHandle;
  client: DaemonClient;
  /** Closed by the user but still following its conversation — see above. */
  hidden?: boolean;
  /** Whether the page is on screen. */
  active?: boolean;
  onClose: () => void;
}): React.JSX.Element {
  const {
    width: height,
    minWidth,
    maxWidth,
    startResize,
    resizeTo,
  } = usePanelWidth({
    storageKey,
    defaultWidth: 420,
    minWidth: 240,
    maxWidth: 900,
    handleEdge: 'top',
  });
  const headerActions = useLatestCallback(
    ({ discard: startOver }: { discard: (() => void) | null }) => (
      <>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-6"
          aria-label="Start a new conversation"
          title="Throw this conversation away and start a new one"
          disabled={startOver === null}
          onClick={() => startOver?.()}>
          <Trash2 className="size-3.5 shrink-0" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-6"
          aria-label={`Hide the ${panelName}`}
          title="Hide — the conversation is kept"
          onClick={onClose}>
          <ChevronDown className="size-3.5 shrink-0" />
        </Button>
      </>
    ),
    [onClose],
  );

  return (
    <aside
      hidden={hidden}
      className="relative flex shrink-0 flex-col border-t border-border bg-sidebar"
      style={{ height }}
      aria-label={label}>
      <PanelResizeHandle
        edge="top"
        label={`Resize the ${panelName}`}
        onMouseDown={startResize}
        value={height}
        min={minWidth}
        max={maxWidth}
        onResize={resizeTo}
      />
      <div className="min-h-0 flex-1">
        <Chats
          client={client}
          handle={handle}
          active={active && !hidden}
          hosted={{ ...thread, headerActions }}
        />
      </div>
    </aside>
  );
}
