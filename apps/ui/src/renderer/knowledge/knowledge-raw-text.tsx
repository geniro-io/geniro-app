/**
 * A document's source as an agent reads it. Rendered Markdown drops comments
 * and unused link references, so text under review is never shown that way.
 */
export function KnowledgeRawText({
  text,
}: {
  text: string;
}): React.JSX.Element {
  return (
    <pre
      data-slot="knowledge-raw"
      className="m-0 min-w-0 overflow-x-auto rounded-card bg-card p-3 font-mono text-xs break-words whitespace-pre-wrap ring-1 ring-border">
      {text}
    </pre>
  );
}
