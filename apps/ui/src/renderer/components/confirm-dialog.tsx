import { ErrorText } from './error-text';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';

/**
 * The one modal confirmation for a destructive action — a title, what is about
 * to happen, and Cancel / <destructive action>. Built on the shared `Dialog`
 * (Escape, backdrop click, focus trap), so a confirm reads and behaves the
 * same everywhere.
 *
 * The caller owns `open` and closes on success; a failed action keeps the
 * dialog up carrying `error`, mirroring `WorkflowMetaDialog`'s contract.
 * While `busy`, Cancel/Escape/backdrop are inert — a half-finished delete
 * must not have its dialog yanked out from under it.
 */
export function ConfirmDialog({
  open,
  busy = false,
  error,
  title,
  confirmLabel,
  busyLabel,
  onCancel,
  onConfirm,
  children,
}: {
  open: boolean;
  /** The action is in flight — both buttons lock. */
  busy?: boolean;
  error?: string | null;
  title: string;
  /** Label of the destructive button (e.g. "Delete"). */
  confirmLabel: string;
  /** Replaces `confirmLabel` while busy (e.g. "Deleting…"). */
  busyLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
  /** What is about to happen, and anything the user can't undo. */
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Dialog
      open={open}
      onClose={busy ? () => undefined : onCancel}
      title={title}>
      <div className="flex flex-col gap-4">
        <div className="text-sm text-muted-foreground">{children}</div>
        {error ? <ErrorText>{error}</ErrorText> : null}
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={onCancel}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={busy}
            onClick={onConfirm}>
            {busy ? busyLabel : confirmLabel}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
