import type React from 'react';

import type { ChangelogRelease } from '../../shared/changelog';
import { ChangelogReleaseCard } from '../components/changelog-release';
import { Button } from '../components/ui/button';
import { Dialog } from '../components/ui/dialog';

/**
 * What changed since the version this profile last saw, opened once after an
 * update. Closing it, by either button, Escape or the backdrop, marks the
 * running version as seen.
 */
export function WhatsNewDialog({
  open,
  releases,
  current,
  onClose,
  onOpenFullChangelog,
}: {
  open: boolean;
  releases: readonly ChangelogRelease[];
  current: string;
  onClose: () => void;
  onOpenFullChangelog: () => void;
}): React.JSX.Element | null {
  const skipped = releases.length;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`What’s new in Geniro ${current}`}
      className="max-w-2xl">
      <div className="flex min-h-0 flex-col gap-4">
        {skipped > 1 ? (
          <p className="text-sm text-muted-foreground">
            Everything that changed in the {skipped} versions since you last
            looked, newest first.
          </p>
        ) : null}
        <div className="-mx-1 flex min-h-0 flex-col gap-3 overflow-y-auto px-1">
          {releases.map((release) => (
            <ChangelogReleaseCard
              key={release.version ?? 'unreleased'}
              release={release}
              current={release.version === current}
            />
          ))}
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
