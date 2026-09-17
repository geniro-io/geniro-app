import '@uiw/react-md-editor/markdown-editor.css';

import type { MDEditorProps } from '@uiw/react-md-editor';
import MDEditor from '@uiw/react-md-editor';

import { useThemeAppearance } from '../../theme/apply-theme';
import { cn } from './utils';

/** An mdast node, as far as {@link rawHtmlAsText} reads one. */
interface MarkdownNode {
  type: string;
  children?: MarkdownNode[];
}

/**
 * Show raw HTML in the PREVIEW as the characters that were typed.
 *
 * The vendor preview runs `rehype-raw`, so anything CommonMark reads as an HTML
 * tag becomes a real element. In a prompt that is a placeholder, not markup:
 * `.claude/worktrees/<linear-id-slug>` opened an unknown `<linear-id-slug>`
 * element that swallowed every line after it, and the preview beside a
 * two-page instruction block showed one and a half sentences. REPORTED against
 * a workflow's instruction block. Turning the `html` nodes into `text` before
 * rehype sees them is what the chat transcript already does for the same words
 * (`react-markdown` escapes HTML by default), so an instruction reads the same
 * in the editor and in the thread it is sent to.
 */
function rawHtmlAsText() {
  return (tree: MarkdownNode): void => {
    const walk = (node: MarkdownNode): void => {
      if (node.type === 'html') {
        node.type = 'text';
      }
      node.children?.forEach(walk);
    };
    walk(tree);
  };
}

const PREVIEW_OPTIONS: MDEditorProps['previewOptions'] = {
  remarkPlugins: [rawHtmlAsText],
};

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
        previewOptions={PREVIEW_OPTIONS}
        textareaProps={{ placeholder }}
      />
    </div>
  );
}
