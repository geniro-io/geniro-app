/** A standing note on a screen, with what can be done about it. */
export function KnowledgeNote({
  children,
  action = null,
}: {
  children: React.ReactNode;
  action?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-3 rounded-card bg-muted px-4 py-3 text-sm">
      <span className="min-w-0 flex-1 break-words">{children}</span>
      {action}
    </div>
  );
}
