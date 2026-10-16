import { Link2 } from 'lucide-react';
import { createContext, useContext, useEffect, useRef, useState } from 'react';

import { ConfirmButton } from '../components/confirm-button';
import { CopyButton } from '../components/copy-button';
import { ErrorText } from '../components/error-text';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Popover } from '../components/ui/popover';
import { cn } from '../components/ui/utils';
import { describeDaemonError } from '../daemon-api';
import type { PublishedArtifact } from './published-artifact';
import {
  type ArtifactSharing,
  revokeFailedMessage,
} from './use-artifact-sharing';

/**
 * How a page's Share control reaches the daemon for the run on screen. Null
 * where a page cannot be shared from — a paired phone, or a surface with no
 * run — and the control then renders nothing.
 */
export const ArtifactShareContext = createContext<ArtifactSharing | null>(null);

/**
 * Share a page as an end-to-end-encrypted link: an icon beside Save, opening a
 * small panel to create, copy, update or revoke the link. Tinted while the
 * page has a live link.
 */
export function ArtifactShareButton({
  artifact,
  className,
}: {
  artifact: PublishedArtifact;
  className?: string;
}): React.JSX.Element | null {
  const sharing = useContext(ArtifactShareContext);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  if (sharing === null) {
    return null;
  }
  const share = sharing.shareOf(artifact.artifactId);
  return (
    <span className="relative inline-flex">
      <Button
        ref={triggerRef}
        type="button"
        variant="ghost"
        size="icon"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={
          share === null
            ? `Share ${artifact.title} as a link`
            : `${artifact.title} is shared — manage its link`
        }
        className={cn(
          'shrink-0',
          share === null ? 'text-muted-foreground' : 'text-primary',
          className,
        )}
        onClick={() => setOpen((value) => !value)}>
        <Link2 className="size-3" />
      </Button>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        triggerRef={triggerRef}
        anchor="viewport"
        side="bottom"
        align="end"
        label={`Share ${artifact.title}`}
        className="w-80 p-3">
        {open && <SharePanel artifact={artifact} sharing={sharing} />}
      </Popover>
    </span>
  );
}

function SharePanel({
  artifact,
  sharing,
}: {
  artifact: PublishedArtifact;
  sharing: ArtifactSharing;
}): React.JSX.Element {
  const share = sharing.shareOf(artifact.artifactId);
  const shareId = share?.id ?? null;
  // `link` alone, not the whole object: the object is rebuilt on every list
  // read, and each rebuild would read the Keychain again.
  const { link } = sharing;
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The link's key lives in the Keychain, never in the list this panel was
  // drawn from, so an existing share's link is read when the panel opens.
  useEffect(() => {
    if (shareId === null) {
      return;
    }
    let cancelled = false;
    void link(shareId)
      .then((found) => {
        if (!cancelled) {
          setUrl(found);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(describeDaemonError(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [link, shareId]);

  const run = (work: () => Promise<void>): void => {
    setBusy(true);
    setError(null);
    void work()
      .catch((err: unknown) => setError(describeDaemonError(err)))
      .finally(() => setBusy(false));
  };

  const createOrUpdate = (): void =>
    run(async () => {
      setUrl(await sharing.share(artifact));
    });

  const revoke = async (id: string): Promise<void> => {
    setError(null);
    try {
      const outcome = await sharing.revoke(id);
      if (outcome.status === 'revoke-failed') {
        setError(revokeFailedMessage(outcome.detail));
        return;
      }
      setUrl(null);
    } catch (err: unknown) {
      setError(describeDaemonError(err));
    }
  };

  return (
    <div className="flex flex-col gap-2 text-sm" data-slot="artifact-share">
      <p className="text-xs text-muted-foreground">
        Encrypted on this Mac — anyone with the link can open the page.
      </p>
      {share === null && url === null ? (
        <Button
          type="button"
          size="sm"
          disabled={busy}
          onClick={createOrUpdate}>
          {busy ? 'Sharing…' : 'Create link'}
        </Button>
      ) : (
        <>
          <div className="flex min-w-0 items-center gap-1">
            <Input
              readOnly
              aria-label="Share link"
              value={url ?? ''}
              placeholder="Reading the link…"
              className="h-7 min-w-0 flex-1 truncate text-xs"
              onFocus={(event) => event.currentTarget.select()}
            />
            {url !== null && <CopyButton text={url} label="Copy link" />}
          </div>
          {share !== null && (
            <>
              <p className="text-xs text-muted-foreground">
                Shared v{share.sharedVersion} to {share.destinationName}
                {share.sharedBy === 'agent' ? ' by an agent' : ''}.
              </p>
              {share.status === 'revoke-failed' && share.lastError !== null && (
                <ErrorText className="text-xs">
                  The last revoke failed: {share.lastError}
                </ErrorText>
              )}
              <div className="flex items-center gap-2">
                {artifact.version > share.sharedVersion && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={createOrUpdate}>
                    Update link to v{artifact.version}
                  </Button>
                )}
                <ConfirmButton
                  size="sm"
                  disabled={busy}
                  confirmLabel="Revoke link?"
                  onConfirm={() => revoke(share.id)}>
                  Revoke
                </ConfirmButton>
              </div>
            </>
          )}
        </>
      )}
      {error !== null && <ErrorText className="text-xs">{error}</ErrorText>}
    </div>
  );
}
