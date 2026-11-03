import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from './ui/utils';

const inheritedTagVariants = cva(
  'shrink-0 text-[10px] tracking-wide uppercase',
  {
    variants: {
      variant: {
        project: 'text-muted-foreground',
        team: 'text-muted-foreground',
        overridden: 'font-medium text-primary',
      },
    },
    defaultVariants: { variant: 'project' },
  },
);

const LABEL: Record<NonNullable<InheritedTagProps['variant']>, string> = {
  project: 'project',
  team: 'team',
  overridden: 'overridden',
};

type InheritedTagProps = VariantProps<typeof inheritedTagVariants>;

/**
 * The muted tag beside a value saying where it comes from: inherited from the
 * project or the shared team, or overridden here. One component, so every row
 * that says it reads as one column.
 */
export function InheritedTag({
  variant,
  className,
}: InheritedTagProps & { className?: string }): React.JSX.Element {
  return (
    <span
      data-slot="inherited-tag"
      data-variant={variant ?? 'project'}
      className={cn(inheritedTagVariants({ variant }), className)}>
      {LABEL[variant ?? 'project']}
    </span>
  );
}
