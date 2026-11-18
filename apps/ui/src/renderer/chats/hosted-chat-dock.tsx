import { ChevronDown, type LucideIcon, Trash2 } from 'lucide-react';
import { useState } from 'react';

import type { DaemonHandle } from '../../shared/contracts';
import { ConfirmDialog } from '../components/confirm-dialog';
import { PanelResizeHandle, usePanelWidth } from '../components/panel-resize';
import { Button } from '../components/ui/button';
import { cn } from '../components/ui/utils';
import { useLatestCallback } from '../components/use-latest-callback';
import type { DaemonClient } from '../daemon-client';
import { Chats } from './Chats';
import type { HostedThread } from './hosted-thread';

/** A surface's own start-over press: the icon, an optional visible label, and what it says to a reader. */
export interface StartOverPress {
  icon: LucideIcon;
  label?: string;
  ariaLabel: string;
  title: string;
}

const DEFAULT_START_OVER: StartOverPress = {
  icon: Trash2,
  ariaLabel: 'Start a new conversation',
  title: 'Throw this conversation away and start a new one',
};

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
  confirmStartOver,
  startOverPress = DEFAULT_START_OVER,
  fill = false,
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
  /** Ask before Start over throws the conversation away, with what is lost. */
  confirmStartOver?: { title: string; body: string; confirmLabel: string };
  /** How the Start over press reads; the default is the trash icon. */
  startOverPress?: StartOverPress;
  /** Take the page's whole height, with no resize handle. */
  fill?: boolean;
  /** Hide the dock; without it the dock offers no Hide. */
  onClose?: () => void;
}): React.JSX.Element {
  const [pendingStartOver, setPendingStartOver] = useState<(() => void) | null>(
    null,
  );
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
    ({ discard }: { discard: (() => void) | null }) => (
      <>
        <Button
          type="button"
          variant="ghost"
          size={startOverPress.label === undefined ? 'icon' : 'sm'}
          className={cn(
            startOverPress.label === undefined
              ? 'size-6'
              : 'h-6 gap-1 px-1.5 text-xs',
          )}
          aria-label={startOverPress.ariaLabel}
          title={startOverPress.title}
          disabled={discard === null}
          onClick={() => {
            if (discard === null) {
              return;
            }
            if (confirmStartOver === undefined) {
              discard();
            } else {
              setPendingStartOver(() => discard);
            }
          }}>
          <startOverPress.icon className="size-3.5 shrink-0" />
          {startOverPress.label}
        </Button>
        {onClose === undefined ? null : (
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
        )}
      </>
    ),
    [onClose, confirmStartOver, startOverPress],
  );

  return (
    <aside
      hidden={hidden}
      className={cn(
        'relative flex flex-col bg-sidebar',
        fill ? 'min-h-0 flex-1' : 'shrink-0 border-t border-border',
      )}
      style={fill ? undefined : { height }}
      aria-label={label}>
      {fill ? null : (
        <PanelResizeHandle
          edge="top"
          label={`Resize the ${panelName}`}
          onMouseDown={startResize}
          value={height}
          min={minWidth}
          max={maxWidth}
          onResize={resizeTo}
        />
      )}
      <div className="min-h-0 flex-1">
        <Chats
          client={client}
          handle={handle}
          active={active && !hidden}
          hosted={{ ...thread, headerActions }}
        />
      </div>
      {confirmStartOver === undefined ? null : (
        <ConfirmDialog
          open={pendingStartOver !== null}
          title={confirmStartOver.title}
          confirmLabel={confirmStartOver.confirmLabel}
          busyLabel={confirmStartOver.confirmLabel}
          onCancel={() => setPendingStartOver(null)}
          onConfirm={() => {
            const startOver = pendingStartOver;
            setPendingStartOver(null);
            startOver?.();
          }}>
          {confirmStartOver.body}
        </ConfirmDialog>
      )}
    </aside>
  );
}
