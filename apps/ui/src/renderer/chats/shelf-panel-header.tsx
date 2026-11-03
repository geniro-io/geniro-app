/** The heading every shelf counter's panel opens with: what the list is, its figure, and one reading on the right. */
export function ShelfPanelHeader({
  title,
  summary,
  aside,
}: {
  title: string;
  summary?: React.ReactNode;
  aside?: React.ReactNode;
}): React.JSX.Element {
  return (
    <header
      data-slot="shelf-panel-header"
      className="mb-1.5 flex min-w-0 items-baseline gap-2 border-b border-border/60 px-1 pb-2">
      <span className="shrink-0 text-sm font-semibold text-foreground">
        {title}
      </span>
      {summary === undefined ? null : (
        <span
          data-slot="shelf-panel-summary"
          className="min-w-0 truncate text-xs text-muted-foreground">
          {summary}
        </span>
      )}
      {aside === undefined ? null : (
        <span className="ml-auto flex shrink-0 items-center gap-1 text-xs text-muted-foreground tabular-nums">
          {aside}
        </span>
      )}
    </header>
  );
}
