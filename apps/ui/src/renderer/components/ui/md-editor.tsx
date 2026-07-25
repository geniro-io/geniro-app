import '@uiw/react-md-editor/markdown-editor.css';

import type { MDEditorProps } from '@uiw/react-md-editor';
import MDEditor from '@uiw/react-md-editor';

import { cn } from './utils';

/**
 * Markdown editor with live preview — the desktop port of the sibling Geniro
 * web app's `components/ui/md-editor.tsx`, so the two surfaces edit prompt
 * text identically (keep them in lockstep like the palette).
 *
 * The upstream chrome paints itself from GitHub Primer variables under
 * `data-color-mode`; `.md-editor-surface` in `styles/global.css` remaps those
 * few variables onto our tokens, so the editor reads as part of the app
 * instead of a white GitHub panel dropped into the cream theme.
 */
export function MdEditor({
  value,
  onChange,
  height = 400,
  preview = 'live',
  readOnly = false,
  placeholder,
  className,
}: {
  value: string;
  onChange?: (value: string) => void;
  height?: number;
  /** 'live' = split (default), 'edit' = editor only, 'preview' = preview only */
  preview?: MDEditorProps['preview'];
  readOnly?: boolean;
  placeholder?: string;
  className?: string;
}): React.JSX.Element {
  return (
    <div data-color-mode="light" className={cn('md-editor-surface', className)}>
      <MDEditor
        value={value}
        onChange={(next) => onChange?.(next ?? '')}
        height={height}
        preview={readOnly ? 'preview' : preview}
        hideToolbar={readOnly}
        textareaProps={{ placeholder }}
      />
    </div>
  );
}
