import { ArrowRight } from 'lucide-react';
import type React from 'react';

import type { ChangelogRelease } from '../../shared/changelog';
import { ChangelogDigest } from '../components/changelog-digest';
import { Button } from '../components/ui/button';
import { Dialog } from '../components/ui/dialog';

/**
 * What changed since the version this profile last saw, opened once after an
 * update: the version range on top, then every change in it as one list.
 * Closing it, by either button, Escape or the backdrop, marks the running
 * version as seen.
 */
export function WhatsNewDialog({
  open,
  releases,
  since,
  current,
  onClose,
  onOpenFullChangelog,
}: {
  open: boolean;
  releases: readonly ChangelogRelease[];
  /** The version the profile last saw; null when it had none. */
  since: string | null;
  current: string;
  onClose: () => void;
  onOpenFullChangelog: () => void;
}): React.JSX.Element | null {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="What’s new in Geniro"
      className="max-w-2xl">
      <div className="flex min-h-0 flex-col gap-5">
        <header data-slot="whats-new-range" className="flex flex-col gap-1">
          <p className="m-0 flex flex-wrap items-center gap-x-2.5 text-2xl font-semibold tabular-nums">
            {since === null ? null : (
              <>
                <span className="text-muted-foreground">{since}</span>
                <ArrowRight
                  aria-label="to"
                  className="size-5 text-muted-foreground"
                />
              </>
            )}
            <span>{current}</span>
          </p>
          <p className="m-0 text-sm text-muted-foreground">
            {since === null
              ? 'What changed in this version.'
              : `You updated from ${since} to ${current}. Every change in between, newest first.`}
          </p>
        </header>
        <div className="-mx-1 min-h-0 overflow-y-auto border-t border-border px-1 pt-5">
          <ChangelogDigest releases={releases} />
        </div>
        <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
          <Button
            variant="outline"
            title="Open the whole changelog in Settings, with search and every earlier version"
            onClick={onOpenFullChangelog}>
            Full changelog
          </Button>
          <Button title="Close and keep working" onClick={onClose}>
            Got it
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
