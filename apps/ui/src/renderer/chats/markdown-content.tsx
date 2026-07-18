import { memo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { cn } from '../components/ui/utils';

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
  code: ({ children, className }) => {
    // A fenced block arrives with a language className; inline code has none.
    const block = typeof className === 'string' && className.length > 0;
    return (
      <code
        className={cn(
          'rounded bg-muted font-mono text-[0.9em]',
          block ? 'block overflow-x-auto p-2 whitespace-pre' : 'px-1 py-0.5',
        )}>
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre className="m-0 overflow-x-auto rounded-md bg-muted p-0 not-first:mt-2">
      {children}
    </pre>
  ),
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
    <div className="overflow-x-auto not-first:mt-2">
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-border bg-muted/50 px-2 py-1 text-left font-semibold">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border border-border px-2 py-1 align-top">{children}</td>
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
