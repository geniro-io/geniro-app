import { X } from 'lucide-react';

import { ZoomableImage } from '../components/ui/image-viewer';
import { cn } from '../components/ui/utils';
import type { StagedAttachment } from './use-attachments';

/**
 * The staged-image row above the composer textarea: what the next message will
 * carry, with a way to take any of it back. Renders nothing when empty so the
 * composer keeps its normal height until something is pasted.
 */
export function AttachmentStrip({
  attachments,
  onRemove,
  className,
}: {
  attachments: StagedAttachment[];
  onRemove: (key: string) => void;
  className?: string;
}): React.JSX.Element | null {
  if (attachments.length === 0) {
    return null;
  }
  return (
    <div className={cn('flex flex-wrap gap-2 px-3 pt-3', className)}>
      {attachments.map((attachment) => (
        <div
          key={attachment.key}
          data-slot="staged-attachment"
          className="group relative size-16 overflow-hidden rounded-lg border border-border bg-muted">
          {/* Checking WHICH screenshot got pasted is the reason to look, and a
              16px-tall crop cannot answer it — least of all after two pastes
              in a row, where the strip's two squares can look identical. */}
          <ZoomableImage
            src={attachment.preview}
            alt={attachment.name}
            title={attachment.name}
            className="block size-full"
            imgClassName="size-full object-cover"
          />
          <button
            type="button"
            aria-label={`Remove ${attachment.name}`}
            onClick={() => onRemove(attachment.key)}
            className="absolute right-0.5 top-0.5 rounded-md bg-background/80 p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100">
            <X className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
