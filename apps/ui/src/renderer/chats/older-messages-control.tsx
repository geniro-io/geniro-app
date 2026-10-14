import { Button } from '../components/ui/button';
import { Spinner } from '../components/ui/spinner';
import { cn } from '../components/ui/utils';

/**
 * "Load earlier messages", or the spinner standing in for it while a page
 * loads — the transcript's and an opened call card's alike.
 *
 * A FIXED height: the button and the spinner differ by 8px, and a page load
 * must not shift the reader.
 */
export function OlderMessagesControl({
  loading,
  onLoad,
  slot,
  className,
}: {
  loading: boolean;
  onLoad: () => void;
  /** The wrapper's `data-slot`; the button's is `<slot>-load`. */
  slot: string;
  className?: string;
}): React.JSX.Element {
  return (
    <div
      data-slot={slot}
      className={cn(
        'flex h-8 shrink-0 items-center gap-1.5 text-xs text-muted-foreground',
        className,
      )}>
      {loading ? (
        <>
          <Spinner />
          Loading earlier messages…
        </>
      ) : (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-slot={`${slot}-load`}
          className="h-6 px-2 text-xs text-muted-foreground"
          onClick={onLoad}>
          Load earlier messages
        </Button>
      )}
    </div>
  );
}
