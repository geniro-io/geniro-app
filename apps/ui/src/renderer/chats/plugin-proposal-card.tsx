import { Puzzle } from 'lucide-react';
import { useMemo, useState } from 'react';

import { Badge } from '../components/ui/badge';
import { Card } from '../components/ui/card';
import { cn } from '../components/ui/utils';
import { SurfaceBody } from './a2ui-components';
import { DiffView } from './diff-view';
import { shortenPath } from './directory-select';
import { SAVE_PLUGIN } from './geniro-tool';
import {
  opensPluginLink,
  pluginSurfaceOf,
  pluginSurfaceState,
} from './plugin-surface';
import { HazardWarning, useHazardGate } from './text-hazard-gate';
import { useOneShotVerdict } from './use-one-shot-verdict';
import { VerdictFooter } from './verdict-footer';

export interface PluginCard {
  summary: string;
  slug: string;
  name: string;
  command: string;
  folders: string[];
  refreshMinutes: number;
  timeoutSeconds: number;
  buttons: { id: string; command: string; confirm: boolean }[];
  view: Record<string, unknown>[];
  sample: unknown;
  oldText: string | null;
  newText: string;
}

/**
 * A `save_plugin` card's input, or null for another tool or a shape that
 * does not read.
 *
 * TWIN PARSER: `pluginCardInput` in the daemon's
 * `agents/utils/host-plugin.ts` writes these keys.
 */
export function pluginCardOf(
  toolName: string,
  input: unknown,
): PluginCard | null {
  if (toolName !== SAVE_PLUGIN || typeof input !== 'object' || input === null) {
    return null;
  }
  const record = input as Record<string, unknown>;
  const strings = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((entry) => typeof entry === 'string');
  const buttons = Array.isArray(record.buttons)
    ? record.buttons.filter(
        (button): button is PluginCard['buttons'][number] =>
          typeof button === 'object' &&
          button !== null &&
          typeof (button as { id?: unknown }).id === 'string' &&
          typeof (button as { command?: unknown }).command === 'string' &&
          typeof (button as { confirm?: unknown }).confirm === 'boolean',
      )
    : null;
  if (
    typeof record.summary !== 'string' ||
    typeof record.slug !== 'string' ||
    typeof record.name !== 'string' ||
    typeof record.command !== 'string' ||
    !strings(record.folders) ||
    typeof record.refreshMinutes !== 'number' ||
    typeof record.timeoutSeconds !== 'number' ||
    buttons === null ||
    !Array.isArray(record.view) ||
    typeof record.new_string !== 'string'
  ) {
    return null;
  }
  return {
    summary: record.summary,
    slug: record.slug,
    name: record.name,
    command: record.command,
    folders: record.folders,
    refreshMinutes: record.refreshMinutes,
    timeoutSeconds: record.timeoutSeconds,
    buttons,
    view: record.view as Record<string, unknown>[],
    sample: record.sample ?? null,
    oldText: typeof record.old_string === 'string' ? record.old_string : null,
    newText: record.new_string,
  };
}

const COMMAND_PREVIEW_CHARS = 120;

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="grid grid-cols-[6rem_1fr] gap-2 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/**
 * The approval card of an agent's new or changed plugin: what it runs, where
 * it shows, how often it refreshes, each button and whether it asks first, a
 * preview drawn from the agent's sample, and the change for an update. Only
 * Approve saves it; everything the file holds is scanned for hidden text.
 */
export function PluginProposalCard({
  card,
  verdict,
  answer,
  outcome,
  expired,
  onRespond,
}: {
  card: PluginCard;
  verdict: boolean | null;
  answer: string | null;
  outcome: unknown;
  expired: boolean;
  onRespond: (allow: boolean) => void;
}): React.JSX.Element {
  const { sending, respond } = useOneShotVerdict(verdict, expired, onRespond);
  const [showCommand, setShowCommand] = useState(false);
  const scan = `${SAVE_PLUGIN} ${card.oldText ?? ''} ${card.newText}`.replace(
    /[\n\t\r]/g,
    ' ',
  );
  const gate = useHazardGate(scan);
  const surface = useMemo(
    () => pluginSurfaceOf(card.slug, card.view, card.sample),
    [card.slug, card.view, card.sample],
  );
  const long = card.command.length > COMMAND_PREVIEW_CHARS;
  const verdictLine =
    verdict && outcome === 'not-saved' ? (
      <p className="text-xs text-destructive">
        ✗ Not saved{answer === null ? null : ` — ${answer}`}
      </p>
    ) : (
      <p
        className={cn(
          'text-xs',
          verdict ? 'text-success' : 'text-destructive',
        )}>
        {verdict ? '✓ Saved' : '✗ Rejected'}
      </p>
    );
  return (
    <Card
      data-slot="plugin-proposal-card"
      className="flex flex-col gap-2.5 border-primary/40 p-3">
      <div className="flex items-center gap-2">
        <Puzzle aria-hidden className="size-4 shrink-0 text-primary" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {card.oldText === null
            ? `Save plugin “${card.name}”?`
            : `Save changes to plugin “${card.name}”?`}
        </span>
        <Badge variant="secondary" className="shrink-0">
          {SAVE_PLUGIN}
        </Badge>
      </div>
      {card.summary === '' ? null : (
        <p className="m-0 text-xs text-muted-foreground">{card.summary}</p>
      )}
      <HazardWarning hazards={gate.hazards} subject="this plugin" />
      <div className="flex flex-col gap-1.5">
        <Row label="Runs">
          <code className="font-mono break-all whitespace-pre-wrap">
            {long && !showCommand
              ? `${card.command.slice(0, COMMAND_PREVIEW_CHARS)}…`
              : card.command}
          </code>
          {long ? (
            <button
              type="button"
              className="ml-1 text-primary hover:underline"
              onClick={() => setShowCommand((current) => !current)}>
              {showCommand ? 'Hide command' : 'Show command'}
            </button>
          ) : null}
        </Row>
        <Row label="In folder">
          the open chat’s folder, stopped after {card.timeoutSeconds} s
        </Row>
        <Row label="Shown in">
          {card.folders.length === 0 ? (
            'every chat'
          ) : (
            <ul className="m-0 flex list-none flex-col p-0">
              {card.folders.map((folder) => (
                <li key={folder} title={folder}>
                  chats under{' '}
                  <code className="font-mono break-all">
                    {shortenPath(folder)}
                  </code>
                </li>
              ))}
            </ul>
          )}
        </Row>
        <Row label="Refresh">
          on open, every {card.refreshMinutes} min while visible, ↻
        </Row>
        {card.buttons.length === 0 ? null : (
          <Row label="Buttons">
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {card.buttons.map((button) => (
                <li key={button.id} className="flex flex-col">
                  <span>
                    <span className="font-medium">{button.id}</span>{' '}
                    <span
                      className={cn(
                        button.confirm
                          ? 'text-muted-foreground'
                          : 'text-warning',
                      )}>
                      {button.confirm ? '· asks first' : '· runs at once'}
                    </span>
                  </span>
                  <code className="font-mono break-all whitespace-pre-wrap text-muted-foreground">
                    {button.command}
                  </code>
                </li>
              ))}
            </ul>
          </Row>
        )}
      </div>
      {card.sample === null ? null : (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Preview</span>
          <div
            data-slot="plugin-preview"
            className="max-h-64 overflow-auto rounded-md border border-border p-2">
            <SurfaceBody
              surface={surface}
              state={pluginSurfaceState(
                surface,
                card.sample,
                { kind: 'idle' },
                () => undefined,
              )}
              inert
              opensLink={opensPluginLink}
            />
          </div>
        </div>
      )}
      {card.oldText === null ? null : (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">What changes</span>
          <div className="max-h-48 overflow-auto">
            <DiffView oldText={card.oldText} newText={card.newText} />
          </div>
        </div>
      )}
      <VerdictFooter
        verdict={verdict}
        expired={expired}
        sending={sending}
        gate={gate}
        respond={respond}
        verdictLine={verdictLine}
      />
    </Card>
  );
}
