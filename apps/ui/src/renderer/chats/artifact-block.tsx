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

  /**
   * Save and open-full-screen, as ONE fragment rendered in one of two places.
   *
   * They live on the FRAME's corner while the card is open and fall back to
   * the heading while it is folded — a folded card has no frame, and a control
   * that vanished with the page would leave a reader who folded a long
   * artifact with no way to save it short of unfolding it again. One fragment
   * rather than two copies, so the two placements cannot drift into two
   * different sets of buttons.
   */
  const controls = (
    <>
      <ArtifactSaveButton
        artifact={artifact}
        saver={saver}
        className="size-5"
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
    </>
  );

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
          {/* FOLDED only — see the block comment on {@link controls}. */}
          {!open && (
            <span className="ml-auto flex items-center gap-1">{controls}</span>
          )}
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
      {open && (
        /* The frame's own top-right CORNER, inside its border.
           REPORTED as "i wanna move icons for open and download artifact to
           border, now they have a lot of margin from bottom": on the heading
           they sat a whole summary line and two margins above the page they
           act on — ~26px of nothing between the control and its subject — and
           a control reads as belonging to whatever it is nearest. On the
           corner it is nearest the page.

           `relative` on a wrapper rather than on the frame: the frame is the
           element the overlay is positioned against, so it cannot also be the
           positioned ancestor. The controls carry their own ground, because
           what is underneath is a document the agent wrote and this app has no
           say in what it draws in that corner. */
        <div className="relative">
          <ArtifactFrame artifact={artifact} />
          <span className="absolute top-1.5 right-1.5 flex items-center gap-0.5 rounded-md border border-border/60 bg-background/80 p-0.5 backdrop-blur-sm">
            {controls}
          </span>
        </div>
      )}
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
