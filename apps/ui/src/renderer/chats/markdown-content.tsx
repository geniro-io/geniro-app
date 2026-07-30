import { memo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { CodeBlock } from '../components/ui/code-block';
import { languageForFence } from '../components/ui/code-language';
import { cn } from '../components/ui/utils';

/** The shape of a hast element, as far as the fence reader needs it. */
interface HastNode {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/**
 * A fenced code block's source and language, read off the `pre`'s hast node.
 *
 * Read from the NODE rather than from the rendered `code` child's props,
 * because a fence with no info string (```` ``` ```` on its own) gives that
 * child no `className` at all — probe-verified — so a className-based
 * "is this a block?" test silently mistakes every language-less fence for
 * inline code. The node says plainly that a `code` element sits inside a
 * `pre`, which is exactly what a fence is.
 *
 * Returns null for anything that is not a single `code` child, leaving the
 * ordinary `<pre>` rendering to handle it.
 */
function readFence(
  node: HastNode | undefined,
): { code: string; language: string | null } | null {
  const child = node?.children?.length === 1 ? node.children[0] : undefined;
  if (child?.tagName !== 'code') {
    return null;
  }
  const classes = child.properties?.className;
  const language = (Array.isArray(classes) ? classes : [])
    .map((entry) => (typeof entry === 'string' ? entry : ''))
    .map((entry) => /^language-([\w+-]+)$/.exec(entry)?.[1])
    .find((entry): entry is string => entry !== undefined);
  // The newline before the closing fence is part of the text and would render
  // as a blank last line. Nothing else is trimmed — leading indentation is
  // meaningful in the code being shown.
  const code = (child.children ?? [])
    .map((text) => text.value ?? '')
    .join('')
    .replace(/\n$/, '');
  return { code, language: languageForFence(language) };
}

/**
 * A GFM column's alignment (`:---`, `:---:`, `---:`) as a utility class.
 *
 * PROBE-VERIFIED against this stack, and NOT what the plan predicted:
 * `mdast-util-to-hast` does emit the deprecated `align` PROPERTY on the hast
 * node, but react-markdown converts it to a `style={{ textAlign }}` object
 * before the component sees it — the `align` prop is `undefined`. Both are
 * read here anyway, so a future version that stops translating still works.
 * Left is the default for an unaligned column, matching prior behaviour.
 */
export function alignClass(
  style: React.CSSProperties | undefined,
  align: string | undefined,
): string {
  switch (style?.textAlign ?? align) {
    case 'center':
      return 'text-center';
    case 'right':
      return 'text-right';
    default:
      return 'text-left';
  }
}

/**
 * Token-styled markdown renderers — the compact mirror of geniro web's
 * MarkdownContent (react-markdown + remark-gfm), trimmed to what the
 * transcript needs: paragraphs, emphasis, lists, code, links, tables,
 * quotes, headings. Colours come from the design tokens only.
 */
const COMPONENTS: Components = {
  p: ({ children }) => (
    <p className="m-0 whitespace-pre-wrap not-first:mt-2">{children}</p>
  ),
  ul: ({ children }) => (
    <ul className="m-0 list-disc pl-5 not-first:mt-2">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="m-0 list-decimal pl-5 not-first:mt-2">{children}</ol>
  ),
  li: ({ children }) => <li className="mt-0.5">{children}</li>,
  h1: ({ children }) => (
    <p className="m-0 text-sm font-bold not-first:mt-2.5">{children}</p>
  ),
  h2: ({ children }) => (
    <p className="m-0 text-sm font-bold not-first:mt-2.5">{children}</p>
  ),
  h3: ({ children }) => (
    <p className="m-0 text-sm font-semibold not-first:mt-2">{children}</p>
  ),
  h4: ({ children }) => (
    <p className="m-0 text-sm font-semibold not-first:mt-2">{children}</p>
  ),
  // Only INLINE code reaches here: a fenced block is intercepted by `pre`
  // below, which renders CodeBlock instead of these children.
  code: ({ children }) => (
    <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]">
      {children}
    </code>
  ),
  pre: ({ children, node }) => {
    const fence = readFence(node);
    if (!fence) {
      return (
        <pre className="m-0 overflow-x-auto rounded-md bg-muted p-0 not-first:mt-2">
          {children}
        </pre>
      );
    }
    // Fenced blocks go through the app's ONE code surface — highlighting and
    // the copy affordance a tool payload already gets — rather than a second,
    // plainer rendering of the same thing. CodeBlock brings its own <pre>, and
    // a <pre> inside a <pre> is invalid, so this wrapper only adds the margin.
    return (
      <div className="not-first:mt-2">
        <CodeBlock code={fence.code} language={fence.language} />
      </div>
    );
  },
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-primary underline underline-offset-2">
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="m-0 border-l-2 border-border pl-3 text-muted-foreground not-first:mt-2">
      {children}
    </blockquote>
  ),
  table: ({ children }) => (
    // No `w-full`: it forces the table to the wrapper's width, so wrappable
    // content hard-wraps inside instead of overflowing — and a table that
    // never overflows never scrolls, however wide its content really is.
    // Letting it size to its content is what hands the wrapper something to
    // scroll.
    <div className="overflow-x-auto not-first:mt-2">
      <table className="border-collapse text-xs">{children}</table>
    </div>
  ),
  th: ({ children, style, align }) => (
    <th
      className={cn(
        'border border-border bg-muted/50 px-2 py-1 font-semibold',
        alignClass(style, align),
      )}>
      {children}
    </th>
  ),
  td: ({ children, style, align }) => (
    <td
      className={cn(
        'border border-border px-2 py-1 align-top',
        alignClass(style, align),
      )}>
      {children}
    </td>
  ),
  hr: () => <hr className="my-2 border-border" />,
};

/** Markdown-rendered message text (geniro web's MarkdownContent). */
export const MarkdownContent = memo(function MarkdownContent({
  content,
  className,
}: {
  content: string;
  className?: string;
}): React.JSX.Element {
  return (
    <div className={cn('min-w-0 text-sm leading-relaxed', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {content}
      </ReactMarkdown>
    </div>
  );
});
