import * as React from 'react';

/**
 * A read-only preview of instruction text geniro sends to an agent on the
 * user's behalf — muted, scrollable past a few lines, wrapped as written. An
 * optional caption names whose text it is.
 */
export function InstructionPreview({
  caption,
  text,
  className,
}: {
  caption?: React.ReactNode;
  text: string;
  className?: string;
}): React.JSX.Element {
  return (
    <div data-slot="instruction-preview" className={className}>
      {caption ? (
        <p className="mt-2 text-xs font-medium text-muted-foreground">
          {caption}
        </p>
      ) : null}
      <pre className="mt-2 max-h-64 overflow-auto rounded-md border border-border bg-muted/40 p-3 text-xs whitespace-pre-wrap text-muted-foreground">
        {text}
      </pre>
    </div>
  );
}
