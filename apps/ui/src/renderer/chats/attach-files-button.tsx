import { Paperclip } from 'lucide-react';

import { buttonVariants } from '../components/ui/button';
import { cn } from '../components/ui/utils';

const ATTACH_LABEL = 'Attach files or images';

/**
 * The composer's paperclip: the browser's own file picker, drawn as a button.
 *
 * A `<input type="file">` rather than the Mac's native dialog over IPC, because
 * it is the one picker that works in BOTH places this composer runs — the
 * Electron window, where a picked `File` still resolves to its path
 * (`GeniroApi.filePath`), and a phone's browser over the LAN gateway, where the
 * native dialog belongs to the Mac and is refused.
 *
 * The input itself lies over the icon, so a press lands on it directly: a mobile
 * browser may ignore a scripted `click()` on a file input.
 *
 * What happens to the files is the caller's (`useFileAttach`); this only picks.
 */
export function AttachFilesButton({
  onFiles,
  disabled = false,
}: {
  onFiles: (files: File[]) => void;
  disabled?: boolean;
}): React.JSX.Element {
  return (
    <span
      data-slot="composer-attach"
      className={cn(
        buttonVariants({ variant: 'ghost', size: 'icon' }),
        'relative size-8 shrink-0 overflow-hidden rounded-full text-muted-foreground has-[:disabled]:pointer-events-none has-[:disabled]:opacity-50 has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50',
      )}>
      <Paperclip className="size-4" aria-hidden />
      <input
        type="file"
        multiple
        data-slot="composer-attach-input"
        className="absolute inset-0 size-full cursor-pointer opacity-0"
        aria-label={ATTACH_LABEL}
        title={ATTACH_LABEL}
        disabled={disabled}
        onChange={(event) => {
          const picked = [...(event.target.files ?? [])];
          // Cleared so picking the SAME file again still fires `change`.
          event.target.value = '';
          if (picked.length > 0) {
            onFiles(picked);
          }
        }}
      />
    </span>
  );
}
