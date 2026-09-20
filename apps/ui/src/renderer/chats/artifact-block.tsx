import { ChevronRight, Maximize2 } from 'lucide-react';
import { useState } from 'react';

import { ErrorText } from '../components/error-text';
import { Button } from '../components/ui/button';
import { ArtifactDialog } from './artifact-dialog';
import { ArtifactFrame } from './artifact-frame';
import { ArtifactSaveButton, useArtifactSaver } from './artifact-save';
import { SectionLabel } from './block-shell';
import type { PublishedArtifact } from './published-artifact';
import { useThreadOverride } from './thread-ui-memory';

/**
 * One published page, as the transcript draws it.
 *
 * It shows the artifact INLINE rather than behind a link, on the gallery card's
 * reasoning: the agent produced this to be looked at, and a card that only
 * names it charges a click to see whether it was worth one. The inline frame is
 * capped, and the control beside the heading opens the same artifact
 * full-screen for a page that wants the room.
 *
 * Folded like its siblings and remembered per thread, since a long page is a
 * screenful of the transcript and a reader scrolling back through a
 * conversation may want it out of the way.
 */
export function ArtifactCard({
  artifact,
  latest = true,
  memoryKey,
}: {
  artifact: PublishedArtifact;
  /**
   * Whether this is the newest card for this artifact. A superseded one starts
   * FOLDED: every open card frames a live sandboxed document, and this is the
   * only revisable card in the family, so a plan revised ten times would
   * otherwise hold ten of them at once. The reader's own press outranks it.
   */
  latest?: boolean;
  /** Where the card's fold is remembered within its thread. */
  memoryKey?: string;
}): React.JSX.Element {
  const [override, setOverride] = useThreadOverride(memoryKey);
  const [full, setFull] = useState(false);
  // ONE saver for both controls — the heading's and the dialog's are the same
  // act on the same document, so they share a busy flag and a failure line.
  const saver = useArtifactSaver();
  // The reader's own press outranks the derived default — `TaskListCard`'s
  // shape, and the same reason: a card that opened itself but could not be
  // shut would be worse than one that never opened.
  const open = override ?? latest;

  return (
    <div data-slot="artifact-card" data-open={open} className="min-w-0">
      <SectionLabel>
        {/* A flex SPAN, not the caption's own box: `SectionLabel` renders a
            `<p>`, so a control meant to sit at the far right of the heading
            falls to a line of its own instead. A span keeps the markup valid
            inside a paragraph. */}
        <span className="flex min-w-0 items-center gap-1">
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOverride(!open)}
            className="flex min-w-0 items-center gap-1">
            <ChevronRight
              aria-hidden="true"
              className="size-3 shrink-0 transition-transform"
              style={{ transform: open ? 'rotate(90deg)' : undefined }}
            />
            <span className="truncate" title={artifact.title}>
              {artifact.title}
            </span>
            {artifact.version > 1 && (
              <span className="shrink-0">· v{artifact.version}</span>
            )}
          </button>
          <ArtifactSaveButton
            artifact={artifact}
            saver={saver}
            className="ml-auto size-5"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-5 shrink-0 text-muted-foreground"
            aria-label={`Open ${artifact.title} full screen`}
            onClick={() => setFull(true)}>
            <Maximize2 className="size-3" />
          </Button>
        </span>
      </SectionLabel>
      {artifact.summary !== null && (
        <p className="mb-1.5 text-xs text-muted-foreground">
          {artifact.summary}
        </p>
      )}
      {saver.error !== null && (
        <ErrorText className="mb-1.5 text-xs">{saver.error}</ErrorText>
      )}
      {open && <ArtifactFrame artifact={artifact} />}
      <ArtifactDialog
        artifact={artifact}
        open={full}
        onClose={() => setFull(false)}
        action={
          <ArtifactSaveButton
            artifact={artifact}
            saver={saver}
            className="size-7"
          />
        }
      />
    </div>
  );
}
