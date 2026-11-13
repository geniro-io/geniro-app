import { X } from 'lucide-react';
import * as React from 'react';
import { useEffect, useRef, useState } from 'react';

import { Button } from './ui/button';
import { cn } from './ui/utils';
import { useLatestCallback } from './use-latest-callback';

export const DEFAULT_ACTION_NOTICE_MS = 10_000;

export interface ActionNoticeAction {
  label: string;
  onAction: () => void;
  variant?: 'default' | 'outline' | 'ghost';
  disabled?: boolean;
}

export type ActionNoticeActions =
  | []
  | [ActionNoticeAction]
  | [ActionNoticeAction, ActionNoticeAction]
  | [ActionNoticeAction, ActionNoticeAction, ActionNoticeAction];

export function ActionNotice({
  message,
  actions = [],
  durationMs = DEFAULT_ACTION_NOTICE_MS,
  onDismiss,
  className,
}: {
  message: React.ReactNode;
  actions?: ActionNoticeActions;
  durationMs?: number;
  onDismiss: () => void;
  className?: string;
}): React.JSX.Element {
  const [hovered, setHovered] = useState(false);
  const remaining = useRef(durationMs);
  const dismiss = useLatestCallback(() => onDismiss(), [onDismiss]);

  useEffect(() => {
    if (hovered) {
      return;
    }
    const started = Date.now();
    const timer = setTimeout(dismiss, remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current = Math.max(
        0,
        remaining.current - (Date.now() - started),
      );
    };
  }, [hovered, dismiss]);

  return (
    <div
      role="status"
      data-slot="action-notice"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={cn(
        'flex items-center gap-2 rounded-lg border border-border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-panel-md',
        className,
      )}>
      <div className="min-w-0 flex-1 break-words">{message}</div>
      {actions.map((action) => (
        <Button
          key={action.label}
          type="button"
          variant={action.variant ?? 'outline'}
          size="sm"
          disabled={action.disabled}
          onClick={action.onAction}>
          {action.label}
        </Button>
      ))}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7 shrink-0"
        aria-label="Dismiss"
        title="Dismiss"
        onClick={onDismiss}>
        <X className="size-3.5" />
      </Button>
    </div>
  );
}
