import { ChevronDown } from 'lucide-react';
import * as React from 'react';

import { Card } from './ui/card';
import { cn } from './ui/utils';

/**
 * A Card whose header is a button that expands/collapses its body. Owns the
 * accessible disclosure wiring (aria-expanded, chevron rotation) so every
 * collapsible block — onboarding agents now, settings groups later — behaves
 * identically. Controlled: the parent owns `open`.
 */
export function CollapsibleCard({
  open,
  onToggle,
  header,
  children,
  className,
}: {
  open: boolean;
  onToggle: () => void;
  header: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <Card className={cn('overflow-hidden', className)}>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-4 py-3 text-left outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring/50">
        {header}
        <ChevronDown
          aria-hidden="true"
          className={cn(
            'ml-auto size-4 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>
      {open ? (
        <div className="flex flex-col gap-4 border-t border-border px-4 py-4">
          {children}
        </div>
      ) : null}
    </Card>
  );
}
