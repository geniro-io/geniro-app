import { ExternalLink, Smartphone } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { RemoteAccessState } from '../../shared/remote';
import { CopyButton } from '../components/copy-button';
import { HoverPopover } from '../components/hover-popover';
import { QrCode } from '../components/qr-code';
import { formatRoute } from '../routing';

/**
 * The chat header's "open this thread on another device" action — copy the
 * link, scan its QR, or open it in the desktop's own browser.
 *
 * `runId` is a PROP, taken from `chat-header.tsx` (which already has it as
 * `activeRun.id`), rather than read from `window.location.hash` during
 * render: `App.tsx` moves the open thread with `history.replaceState`, which
 * fires no `hashchange` event, so a render-time read of the hash could name
 * the PREVIOUS thread after switching to a new one with nothing to tell this
 * component to re-read it.
 *
 * The button is ALWAYS drawn once a thread is open — never withheld and never
 * silently inert when remote access happens to be off. A control that
 * vanished there would look like the feature does not exist; one that did
 * nothing on press would look broken. Its panel says which of the two is
 * true.
 */
export function OpenInBrowser({
  runId,
}: {
  runId: string | null;
}): React.JSX.Element | null {
  const [state, setState] = useState<RemoteAccessState | null>(null);

  useEffect(() => {
    // No thread open — nothing here would draw, so there is nothing to ask
    // main for either. Every OTHER chat surface reaches `window.geniro`
    // unconditionally because a thread is always open by the time it mounts;
    // this one is reached from the header on every route, so it has to ask
    // first — an unguarded call here reached `window.geniro` from screens
    // that stub no such bridge at all.
    if (runId === null) {
      return;
    }
    let cancelled = false;
    void window.geniro
      .getRemoteAccess()
      .then((next) => {
        if (!cancelled) {
          setState(next);
        }
      })
      .catch(() => {
        // Left at `null` — the panel's own "Checking…" line stays accurate
        // rather than claiming an answer main never gave.
      });
    return () => {
      cancelled = true;
    };
  }, [runId]);

  // No thread open — literally nothing here to build a link for, which is the
  // one case a missing control is the honest answer rather than a silent one.
  if (runId === null) {
    return null;
  }

  // The IP link is exactly the fallback for a network where `.local` does
  // not resolve — falling back to "nothing is listening" whenever the
  // `.local` link happens to be absent left the address link unusable on
  // those networks even though `addressUrl` was right there.
  const primaryUrl = state?.hostUrl ?? state?.addressUrl;
  const url = primaryUrl
    ? `${primaryUrl}${formatRoute({ view: 'chats', runId })}`
    : null;

  return (
    <HoverPopover
      slot="open-in-browser"
      label="Open this thread on another device"
      panelLabel="Open this thread on another device"
      side="bottom"
      align="end"
      triggerClassName="size-6 rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
      panelClassName="w-72"
      trigger={<Smartphone aria-hidden="true" className="size-3.5 shrink-0" />}>
      {state === null ? (
        <p className="text-xs text-muted-foreground">Checking remote access…</p>
      ) : !state.enabled ? (
        <p className="text-xs text-muted-foreground">
          Remote access is off. Turn it on in Settings → Remote access to open
          this thread on another device.
        </p>
      ) : url === null ? (
        // `enabled` true but nothing bound a port — exactly the state
        // `enabled`/`listening` are two fields for, and the daemon-analogous
        // gateway's own reason is what explains it, never a guess here.
        <p className="text-xs text-muted-foreground">
          {state.unavailableReason ??
            'Remote access is on, but nothing is listening yet.'}
        </p>
      ) : (
        <div className="flex items-center gap-3">
          <QrCode
            value={url}
            size={128}
            label="Scan to open this thread on your phone"
          />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span className="truncate font-mono text-xs" title={url}>
              {url}
            </span>
            <div className="flex items-center gap-1">
              <CopyButton text={url} label="Copy thread link" />
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                title="Open in your browser"
                aria-label="Open this thread in your browser"
                className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground">
                <ExternalLink
                  aria-hidden="true"
                  className="size-3.5 shrink-0"
                />
              </a>
            </div>
          </div>
        </div>
      )}
    </HoverPopover>
  );
}
