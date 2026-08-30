import '@uiw/react-md-editor/markdown-editor.css';

import type { MDEditorProps } from '@uiw/react-md-editor';
import MDEditor from '@uiw/react-md-editor';

import { useThemeAppearance } from '../../theme/apply-theme';
import { cn } from './utils';

/**
 * Markdown editor with live preview — the desktop port of the sibling Geniro
 * web app's `components/ui/md-editor.tsx`, so the two surfaces edit prompt
 * text identically (keep them in lockstep like the palette).
 *
 * The upstream chrome paints itself from GitHub Primer variables under
 * `data-color-mode`; `.md-editor-surface` in `styles/global.css` remaps those
 * few variables onto our tokens, so the editor reads as part of the app instead
 * of a GitHub panel dropped into it.
 *
 * `data-color-mode` still has to be told which way round the theme is, even
 * though the retint covers the variables that matter: it is what the vendor
 * keys every rule this app does NOT override on. The retint wins in both arms
 * on specificity — its strongest selector is (0,3,0) against the vendor's
 * (0,2,0) for `light` and `dark` alike, and both are unlayered, so source order
 * never has to decide.
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
    <div
      data-color-mode={useThemeAppearance()}
      className={cn('md-editor-surface', className)}>
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
