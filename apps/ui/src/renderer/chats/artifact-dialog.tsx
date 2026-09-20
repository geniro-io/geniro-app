import { Dialog } from '../components/ui/dialog';
import { ArtifactFrame } from './artifact-frame';
import type { PublishedArtifact } from './published-artifact';

/**
 * One published artifact, full-screen.
 *
 * Built on the app's ONE `Dialog` — Escape, the backdrop, the focus trap and
 * the corner ✕ are all that component's, so this adds a size and a heading and
 * nothing else.
 *
 * It takes the dialog's scrolling-content escape hatch, which that component
 * documents: the ROOT goes `h-full` and the part that should move owns its own
 * overflow. Here nothing should move — the page inside the frame scrolls
 * itself, and a scrollbar on the body outside a frame that already has one is
 * the two-bars-side-by-side case the dialog's own notes describe. So the frame
 * FILLS instead of sizing to its content: a document of unknown length has no
 * height worth reserving, and the reader came here for the biggest view of it
 * the window can give.
 */
export function ArtifactDialog({
  artifact,
  open,
  onClose,
}: {
  artifact: PublishedArtifact | null;
  open: boolean;
  onClose: () => void;
}): React.JSX.Element | null {
  if (artifact === null) {
    return null;
  }
  return (
    <Dialog
      open={open}
      onClose={onClose}
      className="h-[88vh] w-full max-w-5xl"
      title={
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate" title={artifact.title}>
            {artifact.title}
          </span>
          {artifact.version > 1 && (
            <span className="shrink-0 text-xs font-normal text-muted-foreground">
              v{artifact.version}
            </span>
          )}
        </div>
      }>
      <div className="h-full">
        <ArtifactFrame artifact={artifact} fill className="h-full" />
      </div>
    </Dialog>
  );
}
