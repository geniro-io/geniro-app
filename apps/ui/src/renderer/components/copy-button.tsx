import { Check, Copy, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { writeClipboard } from '../clipboard';
import { Button } from './ui/button';
import { cn } from './ui/utils';

/** How long the ✓ (or, after a failure, the ✗) stays before the icon reverts. */
const COPIED_WINDOW_MS = 1500;

/**
 * Copy a string to the clipboard, with a brief ✓ acknowledgement.
 *
 * The app's ONE copy control — never re-implemented inline. It takes the text
 * as a prop rather than reading the DOM, because what a user wants is the
 * SOURCE, not whatever the renderer made of it: a highlighted code block is a
 * tree of `<span>`s whose `textContent` silently loses nothing today but would
 * the moment a line-number gutter or an ellipsis is added.
 *
 * A copy can fail (a denied clipboard permission, or a fallback copy the browser refuses), and a
 * button that lies about having copied is worse than one that says it could
 * not — so the ✓ appears only after the write actually resolves.
 */
export function CopyButton({
  text,
  label = 'Copy',
  className,
  ...rest
}: Omit<React.ComponentProps<'button'>, 'onClick' | 'children'> & {
  /** The exact string to place on the clipboard. */
  text: string;
  /** Accessible name; also the tooltip. */
  label?: string;
}): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const revertTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (revertTimer.current) {
        clearTimeout(revertTimer.current);
      }
    },
    [],
  );

  const handleClick = async (): Promise<void> => {
    if (revertTimer.current) {
      clearTimeout(revertTimer.current);
    }
    try {
      await writeClipboard(text);
      setFailed(false);
      setCopied(true);
      revertTimer.current = setTimeout(
        () => setCopied(false),
        COPIED_WINDOW_MS,
      );
    } catch {
      setCopied(false);
      setFailed(true);
      // Shown, not only named: a phone has no tooltip to read it from.
      revertTimer.current = setTimeout(
        () => setFailed(false),
        COPIED_WINDOW_MS,
      );
    }
  };

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={failed ? `${label} failed` : label}
      title={failed ? `${label} failed` : label}
      className={cn('size-6 text-muted-foreground', className)}
      onClick={() => void handleClick()}
      {...rest}>
      {copied ? (
        <Check className="size-3.5 text-success" aria-hidden />
      ) : failed ? (
        <X className="size-3.5 text-destructive" aria-hidden />
      ) : (
        <Copy className="size-3.5" aria-hidden />
      )}
    </Button>
  );
}
