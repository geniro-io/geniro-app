import { cn } from '../components/ui/utils';

export function ProjectSection({
  icon,
  title,
  hint,
  action,
  slot,
  className,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  hint?: string;
  action?: React.ReactNode;
  slot?: string;
  className?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section
      data-slot={slot}
      aria-label={title}
      className={cn(
        'flex min-w-0 flex-col gap-4 rounded-card bg-card p-5 ring-1 ring-border max-sm:p-4',
        className,
      )}>
      <header className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-control bg-muted text-muted-foreground [&_svg]:size-4">
          {icon}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 className="text-base font-semibold">{title}</h2>
          {hint === undefined ? null : (
            <p className="text-sm text-muted-foreground">{hint}</p>
          )}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}
