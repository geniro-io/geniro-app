import { useEffect, useRef, useState } from 'react';

import { Input } from './ui/input';
import { cn } from './ui/utils';

/**
 * A name edited in place: focused and selected on mount, saved on Enter or on
 * leaving the field, abandoned on Escape.
 *
 * The edge cases are why this is one component. An Enter that confirms an IME
 * composition must not save a half-composed name; keys typed here must not
 * reach the row's own handlers (a group folding shut, a terminal's shortcuts);
 * and an UNCHANGED name is a cancel, not a save, or confirming without editing
 * would pin a default label as though the user had chosen it.
 *
 * The caller unmounts it on either outcome — unmounting a focused field fires
 * no blur, so an abandoned draft cannot leak through the save-on-blur path.
 */
export function InlineRenameInput({
  value,
  onCommit,
  onCancel,
  ariaLabel,
  maxLength,
  disabled,
  invalid,
  className,
}: {
  /** The name as it stands, which the draft starts from. */
  value: string;
  /** Called with the edited name, untrimmed; only when it differs from `value`. */
  onCommit: (name: string) => void;
  onCancel: () => void;
  ariaLabel: string;
  maxLength?: number;
  disabled?: boolean;
  invalid?: boolean;
  className?: string;
}): React.JSX.Element {
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const finish = (): void => {
    if (draft.trim() === value.trim()) {
      onCancel();
    } else {
      onCommit(draft);
    }
  };

  return (
    <Input
      ref={inputRef}
      data-slot="inline-rename"
      value={draft}
      maxLength={maxLength}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-invalid={invalid || undefined}
      className={cn('h-6 min-w-0 px-1.5 py-0 text-sm', className)}
      onClick={(event) => event.stopPropagation()}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.nativeEvent.isComposing) {
          return;
        }
        if (event.key === 'Enter') {
          finish();
        } else if (event.key === 'Escape') {
          onCancel();
        }
      }}
      onBlur={() => {
        if (!disabled) {
          finish();
        }
      }}
    />
  );
}
