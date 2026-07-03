import * as React from 'react';

import { Label } from './ui/label';

/**
 * A labelled form control with an optional hint line. Wraps any input/select in
 * the standard label + control + hint stack so every form field — onboarding,
 * settings, the future graph builder — is assembled identically.
 */
export function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
