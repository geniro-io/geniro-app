import { ArrowRight } from 'lucide-react';
import type React from 'react';

import type { ChangelogRelease } from '../../shared/changelog';
import { ChangelogDigest } from '../components/changelog-digest';
import { Button } from '../components/ui/button';
import { Dialog } from '../components/ui/dialog';
import { cn } from '../components/ui/utils';

const COLUMN_CLASS = 'mx-auto w-full max-w-4xl px-8';

/**
 * What changed since the version this profile last saw, opened once after an
 * update over nearly the whole window: the version range on top, then every
 * change in it as one document. Closing it, by either button, Escape or the
 * backdrop, marks the running version as seen.
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
      className="h-full max-w-none"
      flush>
      <div data-slot="whats-new" className="flex h-full flex-col">
        <header
          data-slot="whats-new-range"
          className={cn(COLUMN_CLASS, 'flex shrink-0 flex-col gap-1 py-6')}>
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
        <div
          data-slot="whats-new-body"
          className="min-h-0 flex-1 overflow-y-auto border-t border-border">
          <div className={cn(COLUMN_CLASS, 'py-6')}>
            <ChangelogDigest releases={releases} />
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-border px-5 py-3">
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
