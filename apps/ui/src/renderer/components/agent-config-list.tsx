import { Trash2 } from 'lucide-react';

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

/** Agents that can't run on the binary alone — they also need a saved secret. */
export function needsApiKey(kind: CliKind): boolean {
  return kind === 'cursor-agent';
}

/**
 * Readiness of one agent. "Ready" (green) means the app can actually drive it:
 * the binary was detected AND, for key-gated agents, a key is present. A
 * detected-but-keyless cursor-agent is amber, not green — it can't run yet.
 */
export function statusFor(
  clis: CliDetection[] | null,
  kind: CliKind,
  keyPresent: boolean,
): AgentStatus {
  if (clis === null) {
    return { label: 'Checking…', tone: 'unknown' };
  }
  const detection = clis.find((c) => c.kind === kind) ?? null;
  if (!detection?.found) {
    return { label: 'not found on PATH', tone: 'bad' };
  }
  const version = detection.version ? ` · ${detection.version}` : '';
  if (needsApiKey(kind) && !keyPresent) {
    return { label: `detected${version} · needs API key`, tone: 'warn' };
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
  /** Whether a Cursor key is effectively present (saved OR typed this session). */
  keyPresent: boolean;
  cursorKey: string;
  onCursorKeyChange: (value: string) => void;
  /** Whether a Cursor key is already saved in the Keychain (null = loading). */
  hasStoredKey: boolean | null;
  /** Settings-only: clear the saved Keychain key. Omitted in onboarding. */
  onRemoveKey?: () => void;
}

/**
 * The list of per-agent configuration cards — the single implementation shared
 * by onboarding and Settings, so both surfaces show detection state, binary-path
 * overrides, and the Cursor API key identically. Fully controlled: the parent
 * owns all state and decides how a change is persisted (completeOnboarding vs.
 * updateSettings/saveSecret).
 */
export function AgentConfigList({
  clis,
  open,
  onToggle,
  binaryPaths,
  onBinaryPathChange,
  onBrowse,
  keyPresent,
  cursorKey,
  onCursorKeyChange,
  hasStoredKey,
  onRemoveKey,
}: AgentConfigListProps): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      {CLI_KINDS.map((kind) => {
        const detection = clis?.find((c) => c.kind === kind) ?? null;
        const status = statusFor(clis, kind, keyPresent);
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

            {needsApiKey(kind) ? (
              <Field
                label="Cursor API key"
                htmlFor="cursor-api-key"
                hint={
                  hasStoredKey
                    ? 'A key is already saved in your Keychain — enter a new one to replace it.'
                    : 'Required to run cursor-agent. Stored in your macOS Keychain — never written to disk.'
                }>
                <Input
                  id="cursor-api-key"
                  type="password"
                  placeholder={
                    hasStoredKey
                      ? 'Saved — enter a new key to replace'
                      : 'Cursor API key'
                  }
                  value={cursorKey}
                  onChange={(event) => onCursorKeyChange(event.target.value)}
                />
                {hasStoredKey && onRemoveKey ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="self-start text-destructive hover:text-destructive"
                    onClick={onRemoveKey}>
                    <Trash2 />
                    Remove saved key
                  </Button>
                ) : null}
              </Field>
            ) : (
              <NoteBox>
                Signs in through the {kind} CLI — no API key needed.
              </NoteBox>
            )}
          </CollapsibleCard>
        );
      })}
    </div>
  );
}
