import type { VariantProps } from 'class-variance-authority';
import { useEffect, useRef, useState } from 'react';

import { Button, type buttonVariants } from './ui/button';

/** How long the armed "confirm?" state waits before quietly disarming. */
const ARM_WINDOW_MS = 3000;

/**
 * Two-step destructive action: the first click arms the button (it turns
 * destructive and shows the confirm label), the second click within the window
 * fires. A busy flag holds while the action's promise is in flight, so a
 * double-click can never fire it twice. The one shared confirm control for
 * destructive actions (delete workflow, end terminal session) — never
 * re-implemented inline.
 */
export function ConfirmButton({
  onConfirm,
  confirmLabel = 'Sure?',
  variant = 'outline',
  size,
  className,
  disabled,
  children,
  ...rest
}: Omit<React.ComponentProps<'button'>, 'onClick'> &
  Pick<VariantProps<typeof buttonVariants>, 'variant' | 'size'> & {
    /** The destructive action; awaited — the button stays disabled meanwhile. */
    onConfirm: () => void | Promise<void>;
    /** Label shown while armed. */
    confirmLabel?: React.ReactNode;
  }): React.JSX.Element {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const disarmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (disarmTimer.current) {
        clearTimeout(disarmTimer.current);
      }
    },
    [],
  );

  const handleClick = async (): Promise<void> => {
    if (busy) {
      return;
    }
    if (!armed) {
      setArmed(true);
      disarmTimer.current = setTimeout(() => setArmed(false), ARM_WINDOW_MS);
      return;
    }
    if (disarmTimer.current) {
      clearTimeout(disarmTimer.current);
    }
    setArmed(false);
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button
      type="button"
      variant={armed ? 'destructive' : variant}
      size={size}
      className={className}
      disabled={disabled || busy}
      onClick={() => void handleClick()}
      {...rest}>
      {armed ? confirmLabel : children}
    </Button>
  );
}
