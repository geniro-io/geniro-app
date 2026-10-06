import { Paperclip } from 'lucide-react';
import { useRef } from 'react';

import { Button } from '../components/ui/button';

/**
 * The composer's paperclip: the browser's own file picker, behind one button.
 *
 * A `<input type="file">` rather than the Mac's native dialog over IPC, because
 * it is the one picker that works in BOTH places this composer runs — the
 * Electron window, where a picked `File` still resolves to its path
 * (`GeniroApi.filePath`), and a phone's browser over the LAN gateway, where the
 * native dialog belongs to the Mac and is refused. It is opened synchronously
 * inside the press, which is the only way a mobile browser will show it.
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
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        data-slot="composer-attach-input"
        onChange={(event) => {
          const picked = [...(event.target.files ?? [])];
          // Cleared so picking the SAME file again still fires `change`.
          event.target.value = '';
          if (picked.length > 0) {
            onFiles(picked);
          }
        }}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-8 shrink-0 rounded-full text-muted-foreground"
        aria-label="Attach files or images"
        title="Attach files or images"
        disabled={disabled}
        onClick={() => input.current?.click()}>
        <Paperclip className="size-4" aria-hidden />
      </Button>
    </>
  );
}
