import type { ReactNode } from 'react';

export function NavWarning({
  marked,
  children,
}: {
  marked: boolean;
  children: ReactNode;
}): React.JSX.Element {
  if (!marked) {
    return <>{children}</>;
  }
  return (
    <span className="relative flex shrink-0">
      {children}
      <span
        data-slot="nav-warning"
        aria-hidden="true"
        className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-warning ring-2 ring-sidebar"
      />
    </span>
  );
}

export function navAnnouncement(
  label: string,
  count: number,
  warning: string | undefined,
): string {
  return [label, count > 0 ? `${count} waiting` : null, warning ?? null]
    .filter((part): part is string => part !== null)
    .join(', ');
}
