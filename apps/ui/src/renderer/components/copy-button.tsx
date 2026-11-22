import { Check, Copy, X } from 'lucide-react';

import { writeClipboard } from '../clipboard';
import { Button } from './ui/button';
import { cn } from './ui/utils';
import { useFlash } from './use-flash';

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
  showLabel = false,
  className,
  ...rest
}: Omit<React.ComponentProps<'button'>, 'onClick' | 'children'> & {
  /** The exact string to place on the clipboard. */
  text: string;
  /** Accessible name; also the tooltip. */
  label?: string;
  /** Write the label beside the icon. */
  showLabel?: boolean;
}): React.JSX.Element {
  const { flash, show } = useFlash<'copied' | 'failed'>();
  const copied = flash === 'copied';
  const failed = flash === 'failed';

  const handleClick = async (): Promise<void> => {
    try {
      await writeClipboard(text);
      show('copied');
    } catch {
      // Shown, not only named: a phone has no tooltip to read it from.
      show('failed');
    }
  };

  return (
    <Button
      type="button"
      variant="ghost"
      size={showLabel ? 'sm' : 'icon'}
      aria-label={failed ? `${label} failed` : label}
      title={failed ? `${label} failed` : label}
      className={cn(!showLabel && 'size-6', 'text-muted-foreground', className)}
      onClick={() => void handleClick()}
      {...rest}>
      {copied ? (
        <Check className="size-3.5 text-success" aria-hidden />
      ) : failed ? (
        <X className="size-3.5 text-destructive" aria-hidden />
      ) : (
        <Copy className="size-3.5" aria-hidden />
      )}
      {showLabel ? label : null}
    </Button>
  );
}
