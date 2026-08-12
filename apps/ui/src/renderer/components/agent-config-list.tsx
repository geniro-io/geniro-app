import { LogIn, LogOut } from 'lucide-react';

import {
  CLI_KINDS,
  type CliDetection,
  type CliKind,
} from '../../shared/contracts';
import { CollapsibleCard } from './collapsible-card';
import { Field } from './field';
import { StatusDot, type StatusTone } from './status-dot';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { cn } from './ui/utils';

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
  /**
   * Sign one CLI itself OUT, in the user's own terminal. Settings-only, for the
   * reason its sibling is.
   *
   * Separate handler rather than one `onAccountAction(kind, verb)`: the card
   * decides which of the two to OFFER from the detection state, and the two
   * resolve different daemon routes. A single handler would move that choice
   * into the parent, where the detection it depends on is not the parent's to
   * read.
   */
  onSignOut?: (kind: CliKind) => void;
}

/**
 * The ONE account action on an agent card — whichever of the two the card's
 * detection state makes true.
 *
 * This is the reported defect. The card used to offer Sign in to every detected
 * CLI, including one the probe had just confirmed signed in, and there was no
 * sign-out at all: an action the user cannot need, in the place they look to
 * find out whether setup is finished, reads as an unfinished step. Worse, the
 * one CLI that reported its state was the one being told to sign in again.
 *
 * `loggedIn === true` is the ONLY state that offers Sign out, and the asymmetry
 * with {@link statusFor} is deliberate: there, `null` reads as ready because
 * refusing to guess must not accuse a signed-in user; here, `null` offers Sign
 * in because that is the action which can only help. Signing IN when already
 * signed in costs the user a re-auth they can cancel; signing OUT when the
 * state is unknown could destroy a working session on a probe failure.
 *
 * A card whose parent passed no handler for the action its state calls for
 * renders NOTHING rather than the other one — offering the wrong verb because
 * the right one is unavailable is how a control becomes a lie. (Onboarding
 * passes neither, and the note beside it names Settings as where to go.)
 */
function AccountButton({
  kind,
  loggedIn,
  onSignIn,
  onSignOut,
}: {
  kind: CliKind;
  loggedIn: boolean | null;
  onSignIn?: (kind: CliKind) => void;
  onSignOut?: (kind: CliKind) => void;
}): React.JSX.Element | null {
  if (loggedIn === true) {
    return onSignOut ? (
      // GHOST, where its sign-in sibling is outlined. The weight tracks how
      // likely the user is to want it: signing out of a working CLI is rare and
      // mildly destructive, so it stays quiet and legible rather than competing
      // with the card's own controls.
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="shrink-0 text-muted-foreground"
        onClick={() => onSignOut(kind)}>
        <LogOut className="size-3.5" />
        Sign out
      </Button>
    ) : null;
  }
  return onSignIn ? (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="shrink-0"
      onClick={() => onSignIn(kind)}>
      <LogIn className="size-3.5" />
      Sign in
    </Button>
  ) : null;
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
  onSignOut,
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

            {/* A card FOOTER, not a tinted panel. This used to be a `NoteBox`
                inside the card, which put a box in a box and set a bordered
                button on a filled ground — grey on grey, with the control's own
                fill fighting the panel's. The account state is a property of the
                whole card, so it reads as a band across its foot: the card's own
                background, one hairline rule, and the flat control weight this
                screen already uses for `Re-check`.

                `-mx-4 -mb-4` bleeds through the body's padding so the rule spans
                the full card width; `px-4` puts the content back on the body's
                own gutter. */}
            <div className="-mx-4 -mb-4 flex items-center justify-between gap-3 border-t border-border px-4 py-2.5">
              <span
                className={cn(
                  'text-sm',
                  // Signed out is the one state that asks something of the user,
                  // so it carries the same warn tone as the header's own dot
                  // rather than sitting in muted text beside it.
                  detection?.loggedIn === false
                    ? 'text-warning'
                    : 'text-muted-foreground',
                )}>
                {/* Signed out with no control is a REACHABLE state, not a
                    theoretical one: the sign-in lives on Settings only, and
                    Onboarding — which auto-expands a card that is not ready —
                    passes no handler. Naming where the cure is keeps that
                    screen from being a dead end without moving the control. */}
                {detection?.loggedIn === false
                  ? onSignIn
                    ? `Not signed in to ${kind}.`
                    : `Not signed in to ${kind} — sign in from Settings once setup is done.`
                  : detection?.loggedIn === true
                    ? `Signed in through the ${kind} CLI itself — no key to enter here.`
                    : `Signs in through the ${kind} CLI itself — no key to enter here.`}
              </span>
              {/* `found` matters as much as the handler: the daemon resolves an
                  account target from the bare CLI name without checking it
                  exists, so offering either of these on a card that already says
                  "not found on PATH" opens a terminal that answers `command not
                  found`, where no in-app error can reach the user. */}
              {found ? (
                <AccountButton
                  kind={kind}
                  loggedIn={detection?.loggedIn ?? null}
                  onSignIn={onSignIn}
                  onSignOut={onSignOut}
                />
              ) : null}
            </div>
          </CollapsibleCard>
        );
      })}
    </div>
  );
}
