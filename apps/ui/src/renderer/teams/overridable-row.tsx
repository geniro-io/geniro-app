import { RotateCcw } from 'lucide-react';
import { useId } from 'react';

import { InheritedTag } from '../components/inherited-tag';
import { SettingRow } from '../components/setting-row';
import { Button } from '../components/ui/button';
import { cn } from '../components/ui/utils';

/** Where a row's value comes from in a project's scope; null in the shared scope. */
export interface RowScope {
  projectName: string;
  overridden: boolean;
  teamValue: string;
  onReset: () => void;
}

/** The accent bar down the left edge of a row this project overrides. */
const OVERRIDDEN_EDGE = 'shadow-[inset_2px_0_0_var(--primary)]';

/**
 * The trailing column every overridable setting shares: a quiet Team while it
 * shows the team's value; the project's name and a reset once it is the
 * project's own. Fixed at the row's end, so a card's marks line up whatever
 * width each picker takes.
 */
function ScopeMark({
  label,
  projectName,
  overridden,
  teamValue,
  onReset,
}: Omit<RowScope, 'overridden'> & {
  label: string;
  overridden: boolean;
}): React.JSX.Element {
  if (!overridden) {
    return (
      <InheritedTag
        variant="team"
        className="ml-auto"
        title={`The team’s value; change it to set ${label} for ${projectName} only`}
      />
    );
  }
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1">
      <span
        data-slot="scope-mark"
        className="max-w-28 truncate rounded-pill bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
        {projectName}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-6 rounded-control text-muted-foreground hover:text-foreground max-sm:size-11"
        aria-label={`Reset ${label} to the team’s for ${projectName}`}
        title={`Back to the team’s: ${teamValue}`}
        onClick={onReset}>
        <RotateCcw className="size-3.5" />
      </Button>
    </span>
  );
}

/**
 * A member setting in a project's scope. The control is always live: changing
 * it makes the value this project's own, marked by the accent edge, the
 * project's name and a reset that brings the team's value back.
 */
export function OverridableRow({
  label,
  children,
  ...scope
}: RowScope & {
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const teamId = useId();
  return (
    <div
      data-slot="overridable-row"
      data-overridden={scope.overridden || undefined}
      className={cn(scope.overridden && OVERRIDDEN_EDGE)}>
      <SettingRow width="compact" label={label}>
        <div className="flex w-full min-w-0 items-center gap-2 self-stretch">
          <div
            className="min-w-0 flex-1"
            aria-describedby={scope.overridden ? teamId : undefined}>
            {children}
          </div>
          <ScopeMark label={label} {...scope} />
        </div>
        {scope.overridden ? (
          <span id={teamId} className="text-xs text-muted-foreground">
            Team: {scope.teamValue}
          </span>
        ) : null}
      </SettingRow>
    </div>
  );
}

/**
 * Several member settings that belong together (the model's axes, the pool):
 * a heading row on the same grid as the rows under it, then the live controls,
 * marked as one.
 */
export function OverridableGroup({
  label,
  bare = false,
  children,
  ...scope
}: RowScope & {
  label: string;
  /** Outside a card: no row padding to line up with. */
  bare?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div
      data-slot="overridable-group"
      data-overridden={scope.overridden || undefined}
      className={cn(
        'flex flex-col',
        bare && 'gap-2',
        !bare && scope.overridden && OVERRIDDEN_EDGE,
      )}>
      <div
        className={cn('flex min-w-0 items-center gap-2', !bare && 'px-3 pt-2')}>
        <span className="min-w-0 truncate text-sm text-muted-foreground">
          {label}
        </span>
        <ScopeMark label={label} {...scope} />
      </div>
      {scope.overridden ? (
        <span className={cn('text-xs text-muted-foreground', !bare && 'px-3')}>
          Team: {scope.teamValue}
        </span>
      ) : null}
      {children}
    </div>
  );
}

/** A plain setting row in the shared scope, an {@link OverridableRow} in a project's. */
export function ScopedSettingRow({
  label,
  scope,
  children,
}: {
  label: string;
  scope: RowScope | null;
  children: React.ReactNode;
}): React.JSX.Element {
  return scope === null ? (
    <SettingRow width="compact" label={label}>
      {children}
    </SettingRow>
  ) : (
    <OverridableRow label={label} {...scope}>
      {children}
    </OverridableRow>
  );
}

/** The rows as they are in the shared scope, an {@link OverridableGroup} in a project's. */
export function ScopedGroup({
  label,
  scope,
  bare = false,
  children,
}: {
  label: string;
  scope: RowScope | null;
  bare?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return scope === null ? (
    <>{children}</>
  ) : (
    <OverridableGroup label={label} bare={bare} {...scope}>
      {children}
    </OverridableGroup>
  );
}
