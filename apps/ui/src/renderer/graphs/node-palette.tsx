import {
  Bot,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  SquareTerminal,
  Zap,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import type { CliKind, NodeKind, TriggerKind } from '../../shared/contracts';
import { CLI_KINDS, TRIGGER_KINDS } from '../../shared/contracts';
import { PanelResizeHandle, usePanelWidth } from '../components/panel-resize';
import { Badge } from '../components/ui/badge';
import { Dialog } from '../components/ui/dialog';
import { cn } from '../components/ui/utils';
import {
  type ConnectionRule,
  NODE_CONNECTION_RULES,
  NODE_TYPE_SCHEMAS,
} from './node-schema';

/**
 * Drag payload MIME for dropping a palette entry onto the canvas. The value
 * is a JSON `PaletteItem`; `Graphs`' canvas `onDrop` reads it back and adds
 * the node at the drop position. Clicking a tile opens its info dialog — it
 * does NOT add a node (matches geniro: drag to add, click for details).
 */
export const NODE_DND_MIME = 'application/geniro-node';

/** One draggable palette entry — a node kind plus its concrete variant. */
export type PaletteItem =
  { kind: 'agent'; agent: CliKind } | { kind: 'trigger'; trigger: TriggerKind };

/** Parse a DnD payload back into a PaletteItem (null on garbage). */
export function parsePaletteItem(payload: string): PaletteItem | null {
  try {
    const item = JSON.parse(payload) as PaletteItem;
    if (item.kind === 'agent' && CLI_KINDS.includes(item.agent)) {
      return item;
    }
    if (item.kind === 'trigger' && TRIGGER_KINDS.includes(item.trigger)) {
      return item;
    }
    return null;
  } catch {
    return null;
  }
}

interface TileMeta {
  label: string;
  blurb: string;
  details: string[];
  icon: React.ReactNode;
  /** The `CLI:` line for agents; omitted for triggers. */
  command?: string;
}

const AGENT_META: Record<CliKind, TileMeta> = {
  claude: {
    label: 'Claude',
    command: 'claude',
    blurb: 'Anthropic Claude, driven headlessly via the claude CLI.',
    details: [
      'Runs one turn per node via `claude -p` (headless stream-json).',
      'Tool approvals are per-node — set the node to auto or ask.',
      'Model is configurable per node (empty = the CLI default).',
    ],
    icon: <Bot aria-hidden="true" className="size-4" />,
  },
  'cursor-agent': {
    label: 'Cursor',
    command: 'cursor-agent',
    blurb: 'cursor-agent CLI — runs its tools unattended.',
    details: [
      'Runs one turn per node via `cursor-agent -p` (stream-json).',
      'Runs its tools unattended — approval is always auto.',
      'Needs a Cursor API key (set it in Settings).',
    ],
    icon: <SquareTerminal aria-hidden="true" className="size-4" />,
  },
};

const TRIGGER_META: Record<TriggerKind, TileMeta> = {
  manual: {
    label: 'Manual',
    blurb: 'Fire the workflow by hand with a prompt — the run starts here.',
    details: [
      'Every run enters through a trigger: connect it to your first agent(s).',
      'Firing it seeds the connected agents with the prompt you submit.',
      'Runs no CLI — it completes the moment the run starts.',
    ],
    icon: <Zap aria-hidden="true" className="size-4" />,
  },
};

function metaOf(item: PaletteItem): TileMeta {
  return item.kind === 'agent'
    ? AGENT_META[item.agent]
    : TRIGGER_META[item.trigger];
}

/** Concrete node types matching a connection rule's kind (partner chips). */
function partnersOf(kind: NodeKind): string[] {
  return kind === 'agent'
    ? CLI_KINDS.map((k) => AGENT_META[k].label)
    : TRIGGER_KINDS.map((k) => TRIGGER_META[k].label);
}

// Persisted panel state (survives tab switches / reloads; the builder unmounts
// on every nav change so component state alone would reset the width + fold).
const LS_WIDTH = 'geniro.builder.paletteWidth';
const LS_COLLAPSED = 'geniro.builder.paletteCollapsed';
const LS_AGENTS_OPEN = 'geniro.builder.paletteAgentsOpen';
const LS_TRIGGERS_OPEN = 'geniro.builder.paletteTriggersOpen';

function readBool(key: string, fallback: boolean): boolean {
  const value = localStorage.getItem(key);
  return value === null ? fallback : value === '1';
}

/**
 * One connection rule row in the info dialog: the port dot (input/output
 * colored like the canvas handles), the accepted node kind with its
 * single/multiple arity, the rule description, and the concrete node types
 * matching the rule.
 */
function RuleRow({
  rule,
  direction,
}: {
  rule: ConnectionRule;
  direction: 'input' | 'output';
}): React.JSX.Element {
  return (
    <div className="flex items-start gap-2 px-3 py-2">
      <span
        aria-hidden="true"
        className={cn(
          'mt-1 size-2 shrink-0 rounded-full',
          direction === 'input' ? 'bg-primary' : 'bg-success',
        )}
      />
      <div className="flex min-w-0 flex-col gap-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <code className="text-xs font-semibold">{rule.kind}</code>
          <Badge variant="muted">{rule.multiple ? 'multiple' : 'single'}</Badge>
          {rule.required ? <Badge variant="secondary">required</Badge> : null}
          {partnersOf(rule.kind).map((label) => (
            <Badge key={label} variant="outline">
              {label}
            </Badge>
          ))}
        </span>
        <span className="text-xs text-muted-foreground">
          {rule.description}
        </span>
      </div>
    </div>
  );
}

/**
 * One draggable palette tile. Drag it onto the canvas to add a node; click it
 * to open its info dialog (never adds on click).
 */
function PaletteTile({
  item,
  onInfo,
}: {
  item: PaletteItem;
  onInfo: (item: PaletteItem) => void;
}): React.JSX.Element {
  const meta = metaOf(item);
  return (
    <button
      type="button"
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData(NODE_DND_MIME, JSON.stringify(item));
        event.dataTransfer.effectAllowed = 'move';
      }}
      onClick={() => onInfo(item)}
      className="flex cursor-grab items-start gap-2.5 rounded-lg border border-border bg-card px-3 py-2.5 text-left transition-all hover:border-primary/40 hover:shadow-panel-sm active:cursor-grabbing">
      <span
        className={cn(
          'mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full',
          item.kind === 'trigger'
            ? 'bg-success/15 text-success'
            : 'bg-primary/15 text-primary',
        )}>
        {meta.icon}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium">{meta.label}</span>
        <span className="mt-0.5 line-clamp-2 block text-xs leading-relaxed text-muted-foreground">
          {meta.blurb}
        </span>
      </span>
    </button>
  );
}

/** One collapsible category block (Triggers / Agents). */
function CategoryBlock({
  title,
  count,
  open,
  onToggle,
  children,
}: {
  title: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-full items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-left transition-colors hover:bg-accent/40">
        <span className="text-sm font-medium">{title}</span>
        <span className="text-xs tabular-nums text-muted-foreground">
          {count}
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn(
            'ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform',
            !open && '-rotate-90',
          )}
        />
      </button>
      {open ? (
        <div className="mt-1 mb-1 flex flex-col gap-1">{children}</div>
      ) : null}
    </>
  );
}

/**
 * The builder's left palette — mirrors geniro's `TemplateSidebar`: collapsible
 * category blocks (Triggers + Agents), a fold control that shrinks the whole
 * panel to a slim rail, and a drag-to-resize right edge. Panel width, fold
 * state, and each block's open state persist in localStorage. Nodes are added
 * by dragging a tile onto the canvas; clicking a tile opens its read-only
 * info dialog (schema + connection rules).
 */
export function NodePalette(): React.JSX.Element {
  const [collapsed, setCollapsed] = useState(() =>
    readBool(LS_COLLAPSED, false),
  );
  const { width, startResize } = usePanelWidth({
    storageKey: LS_WIDTH,
    defaultWidth: 240,
    minWidth: 180,
    maxWidth: 400,
    handleEdge: 'right',
  });
  const [agentsOpen, setAgentsOpen] = useState(() =>
    readBool(LS_AGENTS_OPEN, true),
  );
  const [triggersOpen, setTriggersOpen] = useState(() =>
    readBool(LS_TRIGGERS_OPEN, true),
  );
  const [infoItem, setInfoItem] = useState<PaletteItem | null>(null);

  useEffect(() => {
    localStorage.setItem(LS_COLLAPSED, collapsed ? '1' : '0');
  }, [collapsed]);
  useEffect(() => {
    localStorage.setItem(LS_AGENTS_OPEN, agentsOpen ? '1' : '0');
  }, [agentsOpen]);
  useEffect(() => {
    localStorage.setItem(LS_TRIGGERS_OPEN, triggersOpen ? '1' : '0');
  }, [triggersOpen]);

  const closeInfo = useCallback(() => setInfoItem(null), []);

  const infoMeta = infoItem ? metaOf(infoItem) : null;
  const infoRules = infoItem ? NODE_CONNECTION_RULES[infoItem.kind] : null;
  const infoDialog = (
    <Dialog
      open={infoItem !== null}
      onClose={closeInfo}
      title={infoMeta?.label}
      className="max-w-lg">
      {infoItem && infoMeta && infoRules ? (
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-2.5">
            <span
              className={cn(
                'flex size-9 shrink-0 items-center justify-center rounded-full',
                infoItem.kind === 'trigger'
                  ? 'bg-success/15 text-success'
                  : 'bg-primary/15 text-primary',
              )}>
              {infoMeta.icon}
            </span>
            <div className="min-w-0">
              <p className="text-sm text-muted-foreground">{infoMeta.blurb}</p>
              {infoMeta.command ? (
                <p className="mt-0.5 text-xs text-muted-foreground">
                  CLI:{' '}
                  <code className="rounded bg-muted px-1 py-0.5">
                    {infoMeta.command}
                  </code>
                </p>
              ) : null}
            </div>
          </div>
          <ul className="flex flex-col gap-1.5">
            {infoMeta.details.map((detail) => (
              <li
                key={detail}
                className="flex gap-2 text-sm text-muted-foreground">
                <span aria-hidden="true" className="text-primary">
                  •
                </span>
                <span>{detail}</span>
              </li>
            ))}
          </ul>

          <section className="flex flex-col gap-1.5">
            <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              Node schema
            </h3>
            <p className="text-xs text-muted-foreground">
              Every {infoItem.kind} node shares this same schema.
            </p>
            <ul
              aria-label="Node schema"
              className="flex flex-col divide-y divide-border overflow-hidden rounded-md border border-border">
              {NODE_TYPE_SCHEMAS[infoItem.kind].map((field) => (
                <li key={field.key} className="flex flex-col gap-0.5 px-3 py-2">
                  <span className="flex items-center gap-2">
                    <code className="text-xs font-semibold">{field.key}</code>
                    <span className="text-xs text-muted-foreground">
                      {field.type}
                    </span>
                    <Badge
                      variant={field.required ? 'secondary' : 'muted'}
                      className="ml-auto">
                      {field.required ? 'required' : 'optional'}
                    </Badge>
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {field.description}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <section className="flex flex-col gap-1.5">
            <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              Connections
            </h3>
            <p className="text-xs text-muted-foreground">
              Typed per node kind — only listed pairs can be wired on the
              canvas.
            </p>
            <div
              aria-label="Connection rules"
              className="flex flex-col divide-y divide-border overflow-hidden rounded-md border border-border">
              <div>
                <p className="px-3 pt-2 text-xs font-medium">Inputs</p>
                {infoRules.inputs.length === 0 ? (
                  <p className="px-3 pt-1 pb-2 text-xs text-muted-foreground">
                    None — nothing can feed a {infoItem.kind} node; it is an
                    entry point.
                  </p>
                ) : (
                  infoRules.inputs.map((rule) => (
                    <RuleRow
                      key={`in-${rule.kind}`}
                      rule={rule}
                      direction="input"
                    />
                  ))
                )}
              </div>
              <div>
                <p className="px-3 pt-2 text-xs font-medium">Outputs</p>
                {infoRules.outputs.map((rule) => (
                  <RuleRow
                    key={`out-${rule.kind}`}
                    rule={rule}
                    direction="output"
                  />
                ))}
              </div>
            </div>
          </section>

          <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
            Drag this {infoItem.kind} onto the canvas to add it as a node.
          </p>
        </div>
      ) : null}
    </Dialog>
  );

  if (collapsed) {
    return (
      <aside className="flex w-9 shrink-0 flex-col items-center gap-2 border-r border-border bg-muted/40 py-3">
        <button
          type="button"
          aria-label="Expand palette"
          onClick={() => setCollapsed(false)}
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
          <ChevronRight className="size-4" />
        </button>
        <span className="mt-1 rotate-180 text-xs font-medium text-muted-foreground [writing-mode:vertical-rl]">
          Palette
        </span>
      </aside>
    );
  }

  return (
    <aside
      style={{ width }}
      className="relative flex min-h-0 shrink-0 flex-col border-r border-border bg-muted/40">
      <div className="flex-shrink-0 border-b border-border bg-card px-3 py-2.5">
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold">Palette</span>
          <button
            type="button"
            aria-label="Collapse palette"
            onClick={() => setCollapsed(true)}
            className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
            <ChevronLeft className="size-4" />
          </button>
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Drag onto the canvas; click for details.
        </p>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-2">
        <CategoryBlock
          title="Triggers"
          count={TRIGGER_KINDS.length}
          open={triggersOpen}
          onToggle={() => setTriggersOpen((v) => !v)}>
          {TRIGGER_KINDS.map((trigger) => (
            <PaletteTile
              key={trigger}
              item={{ kind: 'trigger', trigger }}
              onInfo={setInfoItem}
            />
          ))}
        </CategoryBlock>

        <CategoryBlock
          title="Agents"
          count={CLI_KINDS.length}
          open={agentsOpen}
          onToggle={() => setAgentsOpen((v) => !v)}>
          {CLI_KINDS.map((agent) => (
            <PaletteTile
              key={agent}
              item={{ kind: 'agent', agent }}
              onInfo={setInfoItem}
            />
          ))}
        </CategoryBlock>
      </div>

      <PanelResizeHandle
        edge="right"
        label="Resize palette"
        onMouseDown={startResize}
      />

      {infoDialog}
    </aside>
  );
}
