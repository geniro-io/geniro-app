import type { ComponentProps, ReactNode } from 'react';

import { Textarea } from '../components/ui/textarea';
import { cn } from '../components/ui/utils';
import { AttachFilesButton } from './attach-files-button';
import { AttachmentStrip } from './attachment-strip';
import { COMPOSER_TEXTAREA_GROWTH, ComposerCard } from './composer-card';
import { ComposerBottomRow } from './composer-rows';
import { insertPastedFilePaths } from './paste-file-paths';
import type { StagedAttachment } from './use-attachments';

/** The same message input, attachments and control row on every chat surface. */
export function MessageComposer({
  attachments,
  onRemoveAttachment,
  onAttachFiles,
  onPasteImages,
  textareaProps,
  actions,
  notice,
  children,
}: {
  attachments: StagedAttachment[];
  onRemoveAttachment: (key: string) => void;
  onAttachFiles: (files: File[]) => void;
  onPasteImages: (data: DataTransfer | null) => boolean;
  textareaProps: Omit<ComponentProps<typeof Textarea>, 'onPaste'>;
  actions: ReactNode;
  /**
   * A line at the bottom of the message box, under the text and above the
   * controls — something the user should know before pressing Send (the
   * prompt cache having lapsed). It renders nothing when it has nothing to say.
   */
  notice?: ReactNode;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <ComposerCard>
      <AttachmentStrip
        attachments={attachments}
        onRemove={onRemoveAttachment}
      />
      <Textarea
        {...textareaProps}
        className={cn(
          COMPOSER_TEXTAREA_GROWTH,
          'min-h-16 rounded-2xl border-0 bg-transparent px-4 pt-3.5 shadow-none focus-visible:border-0 focus-visible:ring-0',
          textareaProps.className,
        )}
        onPaste={(event) => {
          const staged = onPasteImages(event.clipboardData);
          const pathed = insertPastedFilePaths(event.clipboardData);
          if (staged || pathed) {
            event.preventDefault();
          }
        }}
      />
      {notice}
      <ComposerBottomRow
        leading={
          <AttachFilesButton
            onFiles={onAttachFiles}
            disabled={textareaProps.disabled}
          />
        }
        actions={actions}>
        {children}
      </ComposerBottomRow>
    </ComposerCard>
  );
}
