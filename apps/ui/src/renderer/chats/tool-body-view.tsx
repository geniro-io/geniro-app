import { CodeBlock } from '../components/ui/code-block';
import { DiffView } from './diff-view';
import { shortenPath, type ToolBody } from './tool-render';

/**
 * One rendering of a {@link ToolBody} — a captioned diff, or a highlighted code
 * block.
 *
 * EXTRACTED rather than written fresh: this branch stood in four places (the
 * grouped tool row's input and result, and the ungrouped call's and result's),
 * and they had already drifted — only one of them rendered the diff's caption, so
 * the same edit named its file in a group and named nothing outside one. One
 * component is what makes them structurally incapable of disagreeing.
 */
export function ToolBodyView({ body }: { body: ToolBody }): React.JSX.Element {
  if (body.kind === 'diff') {
    return (
      <>
        {body.caption ? (
          // Shortened from the FRONT with the whole thing on hover: a diff's
          // caption is a path, and CSS truncation cuts off the filename — the one
          // part of it that identifies what changed.
          <div
            title={body.caption}
            className="truncate font-mono text-xs text-muted-foreground">
            {shortenPath(body.caption)}
          </div>
        ) : null}
        <DiffView oldText={body.oldText} newText={body.newText} />
      </>
    );
  }
  return (
    <CodeBlock
      code={body.code}
      language={body.language}
      caption={body.caption}
    />
  );
}
