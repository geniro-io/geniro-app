import type { VariantProps } from 'class-variance-authority';
import { useState } from 'react';

import { ConfirmDialog } from './confirm-dialog';
import { Button, type buttonVariants } from './ui/button';

/**
 * A button whose action is asked about first in the one confirmation dialog
 * ({@link ConfirmDialog}): the press opens it, Confirm runs `onConfirm` with
 * both buttons locked, a failure stays in the dialog with its reason, and a
 * success closes it.
 */
export function ConfirmActionButton({
  question,
  description,
  confirmLabel,
  busyLabel,
  confirmVariant,
  onConfirm,
  variant = 'outline',
  size = 'sm',
  className,
  disabled,
  children,
  'aria-label': ariaLabel,
  ...rest
}: Omit<React.ComponentProps<'button'>, 'onClick'> &
  Pick<VariantProps<typeof buttonVariants>, 'variant' | 'size'> & {
    /** The dialog's title, e.g. "Remove this worktree?". */
    question: string;
    /** What is about to happen, and what cannot be undone. */
    description: React.ReactNode;
    confirmLabel: string;
    busyLabel: string;
    confirmVariant?: 'destructive' | 'default';
    onConfirm: () => void | Promise<void>;
  }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      setOpen(false);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        type="button"
        variant={variant}
        size={size}
        className={className}
        disabled={disabled || busy}
        aria-label={ariaLabel}
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
        {...rest}>
        {children}
      </Button>
      <ConfirmDialog
        open={open}
        busy={busy}
        error={error}
        title={question}
        confirmLabel={confirmLabel}
        busyLabel={busyLabel}
        confirmVariant={confirmVariant}
        onCancel={() => setOpen(false)}
        onConfirm={() => void confirm()}>
        {description}
      </ConfirmDialog>
    </>
  );
}
