import { ArrowLeft } from 'lucide-react';

import { Button } from './ui/button';

/** The way back from a library item's page to its library ("← Teams"). */
export function BackLink({
  label,
  onClick,
}: {
  /** The library's name, shown after the arrow. */
  label: string;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <Button
      type="button"
      variant="ghost"
      aria-label={`Back to ${label.toLowerCase()}`}
      className="h-8 gap-1.5 rounded-control px-2 text-muted-foreground hover:text-foreground"
      onClick={onClick}>
      <ArrowLeft aria-hidden="true" /> {label}
    </Button>
  );
}
