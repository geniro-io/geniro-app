import { Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';

import { Button } from '../components/ui/button';
import { Popover } from '../components/ui/popover';

/**
 * Delete a card: a small trash icon in the panel's icon row, confirmed in a
 * popup anchored to it.
 *
 * An ICON because the row it sits in is the panel's icon-only group — asked for
 * as "delete task button should be small icon with popup confirmation" against
 * a labelled Delete that out-weighed Run. And a POPUP rather than the two-press
 * arming `ConfirmButton` does, because an icon has no label to swap for "Delete
 * task?": the question needs a surface of its own, and a popover keeps it
 * beside the control that asked instead of a modal over the whole board.
 *
 * The popup stays open while the delete is in flight and locks both buttons,
 * so a second press cannot send a second delete; Escape and an outside press
 * are ignored for the same reason. It closes itself once the delete settles —
 * the panel that owns it has usually unmounted by then.
 */
export function TaskDeleteButton({
  disabled = false,
  onConfirm,
}: {
  /** The card cannot be deleted right now; the caller says why elsewhere. */
  disabled?: boolean;
  onConfirm: () => void | Promise<void>;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const confirm = async (): Promise<void> => {
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
      setOpen(false);
    }
  };

  return (
    <>
      <Button
        ref={triggerRef}
        variant="ghost"
        size="sm"
        // The one control in the group that destroys something, so its hover
        // says so; at rest it is as quiet as its neighbours.
        className="hover:text-destructive"
        aria-label="Delete task"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Delete this task"
        disabled={disabled}
        onClick={() => {
          setOpen((current) => !current);
        }}>
        <Trash2 className="size-4" aria-hidden />
      </Button>
      <Popover
        open={open}
        onClose={() => {
          if (!busy) {
            setOpen(false);
          }
        }}
        triggerRef={triggerRef}
        side="bottom"
        align="end"
        // The panel scrolls, and the dialog arm's header sits above a scroller
        // of its own — either would clip an absolutely-placed panel.
        anchor="viewport"
        label="Delete this task?"
        className="w-64 p-3">
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium">Delete this task?</span>
            <span className="text-xs text-muted-foreground">
              The card cannot be brought back. Any branch its agent worked on is
              kept.
            </span>
          </div>
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                setOpen(false);
              }}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={busy}
              onClick={() => {
                void confirm();
              }}>
              {busy ? 'Deleting…' : 'Delete'}
            </Button>
          </div>
        </div>
      </Popover>
    </>
  );
}
