import { LogIn } from 'lucide-react';

import {
  CLI_KINDS,
  type CliDetection,
  type CliKind,
} from '../../shared/contracts';
import { CollapsibleCard } from './collapsible-card';
import { Field } from './field';
import { NoteBox } from './note-box';
import { StatusDot, type StatusTone } from './status-dot';
import { Button } from './ui/button';
import { Input } from './ui/input';

export type AgentStatus = { label: string; tone: StatusTone };

/**
 * Readiness of one agent. "Ready" (green) means the binary was detected AND,
 * for a CLI whose own status command was actually asked and answered, it did
 * not say signed-out.
 *
 * `loggedIn === false` is the ONLY thing that renders warn: a CLI that said so
 * itself. `null` — no status command to ask (claude today) or a probe that
 * failed — reads as ready, same as `true`. Treating it as signed-out would
 * tell an already-signed-in user to sign in again, for a fix that would not
 * even address a probe failure.
 */
export function statusFor(
  clis: CliDetection[] | null,
  kind: CliKind,
): AgentStatus {
  if (clis === null) {
    return { label: 'Checking…', tone: 'unknown' };
  }
  const detection = clis.find((c) => c.kind === kind) ?? null;
  if (!detection?.found) {
    return { label: 'not found on PATH', tone: 'bad' };
  }
  const version = detection.version ? ` · ${detection.version}` : '';
  if (detection.loggedIn === false) {
    return { label: `detected${version} · not signed in`, tone: 'warn' };
  }
  return { label: `ready${version}`, tone: 'ok' };
}

const STATUS_TEXT: Record<StatusTone, string> = {
  ok: 'text-sm text-success',
  warn: 'text-sm text-warning',
  bad: 'text-sm text-destructive',
  unknown: 'text-sm text-muted-foreground',
};

export interface AgentConfigListProps {
  /** Detection results (null while probing). */
  clis: CliDetection[] | null;
  /** Which agent cards are expanded. */
  open: Partial<Record<CliKind, boolean>>;
  onToggle: (kind: CliKind) => void;
  /** Per-agent binary path override (blank = auto-detect on PATH). */
  binaryPaths: Partial<Record<CliKind, string>>;
  onBinaryPathChange: (kind: CliKind, value: string) => void;
  onBrowse: (kind: CliKind) => void;
  /**
   * Sign one CLI itself back in, in the user's own terminal. Settings-only —
   * onboarding passes nothing, and a card renders no control without it: the
   * decided placement for this action is Settings, not first-run setup.
   */
  onSignIn?: (kind: CliKind) => void;
}

/**
 * The list of per-agent configuration cards — the single implementation shared
 * by onboarding and Settings, so both surfaces show detection state and
 * binary-path overrides identically. Fully controlled: the parent owns all
 * state and decides how a change is persisted (completeOnboarding vs.
 * updateSettings).
 */
export function AgentConfigList({
  clis,
  open,
  onToggle,
  binaryPaths,
  onBinaryPathChange,
  onBrowse,
  onSignIn,
}: AgentConfigListProps): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      {CLI_KINDS.map((kind) => {
        const detection = clis?.find((c) => c.kind === kind) ?? null;
        const status = statusFor(clis, kind);
        const isOpen = Boolean(open[kind]);
        const pathId = `agent-path-${kind}`;
        const found = Boolean(detection?.found);
        return (
          <CollapsibleCard
            key={kind}
            open={isOpen}
            onToggle={() => onToggle(kind)}
            header={
              <>
                <StatusDot tone={status.tone} />
                <span className="font-medium">{kind}</span>
                <span className={STATUS_TEXT[status.tone]}>{status.label}</span>
              </>
            }>
            <Field
              label="Binary path"
              htmlFor={pathId}
              hint={
                found
                  ? 'Detected here — edit to pin a different binary.'
                  : `Set the full path to the ${kind} binary.`
              }>
              <div className="flex gap-2">
                <Input
                  id={pathId}
                  type="text"
                  placeholder="Auto-detect on PATH"
                  value={binaryPaths[kind] ?? ''}
                  onChange={(event) =>
                    onBinaryPathChange(kind, event.target.value)
                  }
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => onBrowse(kind)}>
                  Browse…
                </Button>
              </div>
            </Field>

            <NoteBox className="flex items-center justify-between gap-3">
              <span>
                {/* Signed out with no control is a REACHABLE state, not a
                    theoretical one: the sign-in lives on Settings only, and
                    Onboarding — which auto-expands a card that is not ready —
                    passes no handler. Naming where the cure is keeps that
                    screen from being a dead end without moving the control. */}
                {detection?.loggedIn === false
                  ? onSignIn
                    ? `Not signed in to ${kind}.`
                    : `Not signed in to ${kind} — sign in from Settings once setup is done.`
                  : `Signs in through the ${kind} CLI itself — no key to enter here.`}
              </span>
              {/* `found` matters as much as the handler: the daemon resolves a
                  login target from the bare CLI name without checking it exists,
                  so offering this on a card that already says "not found on
                  PATH" opens a terminal that answers `command not found`, where
                  no in-app error can reach the user. */}
              {onSignIn && found ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  onClick={() => onSignIn(kind)}>
                  <LogIn className="size-3.5" />
                  Sign in
                </Button>
              ) : null}
            </NoteBox>
          </CollapsibleCard>
        );
      })}
    </div>
  );
}
