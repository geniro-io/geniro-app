import { useId } from 'react';

import { InheritedTag } from '../components/inherited-tag';
import { SettingRow } from '../components/setting-row';
import { Button } from '../components/ui/button';
import { cn } from '../components/ui/utils';

/** What a row needs to offer Override in a project's scope; null in the shared scope. */
export interface RowScope {
  projectName: string;
  overridden: boolean;
  teamValue: string;
  onOverride: () => void;
  onReset: () => void;
}

/**
 * The trailing column every overridable setting shares: where the value comes
 * from, and the one quiet action that flips it. Fixed at the row's end, so the
 * tags of a card's rows line up whatever width each picker takes.
 */
function OverrideControl({
  label,
  projectName,
  overridden,
  onOverride,
  onReset,
}: Pick<RowScope, 'projectName' | 'overridden' | 'onOverride' | 'onReset'> & {
  label: string;
}): React.JSX.Element {
  return (
    <div className="ml-auto flex shrink-0 items-center gap-1">
      <InheritedTag variant={overridden ? 'overridden' : 'team'} />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-6 rounded-control px-2 text-xs font-normal text-muted-foreground hover:text-foreground max-sm:h-11"
        aria-label={
          overridden
            ? `Reset ${label} to the team’s for ${projectName}`
            : `Override ${label} for ${projectName}`
        }
        onClick={overridden ? onReset : onOverride}>
        {overridden ? 'Reset' : 'Override'}
      </Button>
    </div>
  );
}

/**
 * A member setting in a project's scope: the team's value, read-only, with
 * Override; or this project's own value, editable, with Reset and what the
 * team would give. The control itself is the shared picker either way, made
 * inert while it shows the team's value.
 */
export function OverridableRow({
  label,
  projectName,
  overridden,
  teamValue,
  onOverride,
  onReset,
  children,
}: RowScope & {
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const teamId = useId();
  return (
    <SettingRow width="compact" label={label}>
      <div
        data-slot="overridable-row"
        data-overridden={overridden || undefined}
        className="flex w-full min-w-0 items-center gap-2 self-stretch">
        <div
          className={cn('min-w-0 flex-1', !overridden && 'opacity-60')}
          inert={!overridden}
          aria-describedby={overridden ? teamId : undefined}>
          {children}
        </div>
        <OverrideControl
          label={label}
          projectName={projectName}
          overridden={overridden}
          onOverride={onOverride}
          onReset={onReset}
        />
      </div>
      {overridden ? (
        <span id={teamId} className="text-xs text-muted-foreground">
          Team: {teamValue}
        </span>
      ) : null}
    </SettingRow>
  );
}

/**
 * Several member settings overridden together (the model's axes, the pool):
 * a heading row on the same grid as the rows under it, then the shared
 * controls, inert while they show the team's values.
 */
export function OverridableGroup({
  label,
  projectName,
  overridden,
  teamValue,
  onOverride,
  onReset,
  bare = false,
  children,
}: RowScope & {
  label: string;
  /** Outside a card: no row padding to line up with. */
  bare?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div
      data-slot="overridable-group"
      data-overridden={overridden || undefined}
      className={cn('flex flex-col', bare && 'gap-2')}>
      <div
        className={cn('flex min-w-0 items-center gap-2', !bare && 'px-3 pt-2')}>
        <span className="min-w-0 truncate text-sm text-muted-foreground">
          {label}
        </span>
        <OverrideControl
          label={label}
          projectName={projectName}
          overridden={overridden}
          onOverride={onOverride}
          onReset={onReset}
        />
      </div>
      {overridden ? (
        <span className={cn('text-xs text-muted-foreground', !bare && 'px-3')}>
          Team: {teamValue}
        </span>
      ) : null}
      <div className={cn(!overridden && 'opacity-60')} inert={!overridden}>
        {children}
      </div>
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
