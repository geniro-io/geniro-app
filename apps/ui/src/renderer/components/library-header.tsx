/** A library page's header: its title and count, what it holds, and the buttons that add to it. */
export function LibraryHeader({
  title,
  count,
  subtitle,
  actions,
}: {
  title: string;
  /** Null until the first read lands. */
  count: number | null;
  subtitle: string;
  actions: React.ReactNode;
}): React.JSX.Element {
  return (
    <header className="flex flex-wrap items-end gap-x-4 gap-y-3">
      <div className="flex min-w-0 flex-col gap-1">
        <h2 className="flex items-baseline gap-2 text-title font-semibold">
          {title}
          {count === null ? null : (
            <span className="text-base font-normal text-muted-foreground tabular-nums">
              {count}
            </span>
          )}
        </h2>
        <p className="text-sm text-muted-foreground">{subtitle}</p>
      </div>
      <div className="ml-auto flex items-center gap-2">{actions}</div>
    </header>
  );
}
