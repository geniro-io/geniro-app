import { toJsxRuntime } from 'hast-util-to-jsx-runtime';
import { useMemo } from 'react';
import { Fragment, jsx, jsxs } from 'react/jsx-runtime';
import { refractor } from 'refractor';

import { registered } from './code-language';
import { cn } from './utils';

/**
 * A block of source, highlighted.
 *
 * The one place highlighted code is styled — a shell command, a file's
 * contents, a tool payload. Colours come entirely from the `--code-*` tokens
 * in `styles/global.css`, applied through the `.token.*` rules scoped to this
 * component's `data-slot`, so nothing here hardcodes a value and the palette
 * moves with the rest of the theme.
 *
 * Highlighting is best-effort by design: an unknown or unregistered language,
 * or a grammar that throws on malformed input, renders the code as plain text.
 * A tool payload is arbitrary bytes from an agent — it must never be able to
 * break the transcript it appears in.
 */
export function CodeBlock({
  code,
  language,
  caption,
  className,
}: {
  code: string;
  /** Prism grammar id; null renders plain, unhighlighted text. */
  language?: string | null;
  /** Small muted line above the block — typically the file path. */
  caption?: string | null;
  className?: string;
}): React.JSX.Element {
  const grammar = registered(language);
  const highlighted = useMemo<React.ReactNode>(() => {
    if (grammar === null) {
      return null;
    }
    try {
      // hast-util-to-jsx-runtime is typed against its own JSX-runtime shape,
      // which does not line up with React's own — the value IS a React node,
      // so the annotation states that rather than letting it widen.
      return toJsxRuntime(refractor.highlight(code, grammar), {
        Fragment,
        jsx,
        jsxs,
      }) as React.ReactNode;
    } catch {
      // A grammar can throw on input it cannot parse; plain text is a fine
      // answer and an unreadable transcript is not.
      return null;
    }
  }, [code, grammar]);
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      {caption ? (
        <div className="truncate font-mono text-xs text-muted-foreground">
          {caption}
        </div>
      ) : null}
      <pre
        data-slot="code-block"
        data-language={grammar ?? 'text'}
        className={cn(
          'm-0 max-h-64 overflow-auto rounded-md bg-muted px-2.5 py-2 font-mono text-xs leading-relaxed text-foreground',
          className,
        )}>
        <code>{highlighted ?? code}</code>
      </pre>
    </div>
  );
}
