import {
  ArrowRightLeft,
  FilePen,
  FilePlus,
  FileText,
  Globe,
  type LucideIcon,
  Plug,
  Search,
  SquareTerminal,
  Trash2,
  Users,
} from 'lucide-react';

import { cn } from '../components/ui/utils';
import { type BlockStatus, BlockStatusIcon } from './block-shell';
import { type ToolOperation, toolOperationOf } from './tool-kind';

/**
 * The glyph for each kind of work a tool call does.
 *
 * One table, keyed by the same {@link ToolOperation} the group summary counts
 * with — so the row's icon and the header's "read 4 files · ran 3 commands" can
 * never describe the same call differently. A second classification here is what
 * that would take, and it is exactly the drift
 * `.claude/rules/renderer-components.md` forbids.
 *
 * `tone` is a two-tier split, not a colour per operation: work that CHANGED
 * something (an edit, a write, a delete, a command) reads in the accent tone,
 * and work that only looked (a read, a search, a fetch) stays muted. That is the
 * distinction a reader actually scans a collapsed turn for, and ten tinted
 * glyphs would flatten it back into decoration. Both are existing tokens — no
 * new colour enters `styles/global.css` for this.
 */
export const TOOL_OPERATION_META: Record<
  ToolOperation,
  { icon: LucideIcon; tone: string; label: string }
> = {
  read: { icon: FileText, tone: 'text-muted-foreground', label: 'read' },
  search: { icon: Search, tone: 'text-muted-foreground', label: 'searched' },
  fetch: { icon: Globe, tone: 'text-muted-foreground', label: 'fetched' },
  // A CLI's own in-process delegate. Muted: the delegation itself changed
  // nothing — whatever the delegate DID renders in its own block below.
  delegate: { icon: Users, tone: 'text-muted-foreground', label: 'delegated' },
  // Any server tool at all, so its effect is unknowable from here. It wears the
  // same plug the agents panel's MCP control does, which is the point: a reader
  // who has opened that dialog already knows what this row came from.
  mcp: { icon: Plug, tone: 'text-muted-foreground', label: 'MCP tool' },
  edit: { icon: FilePen, tone: 'text-primary', label: 'edited' },
  create: { icon: FilePlus, tone: 'text-primary', label: 'created' },
  execute: { icon: SquareTerminal, tone: 'text-primary', label: 'ran' },
  // Destructive rather than accent, and the only operation that gets its own
  // tone: undoing an unwanted edit is reading a diff, undoing an unwanted delete
  // may not be possible at all.
  delete: { icon: Trash2, tone: 'text-destructive', label: 'deleted' },
  move: { icon: ArrowRightLeft, tone: 'text-primary', label: 'moved' },
};

/**
 * One operation's glyph, drawn from {@link TOOL_OPERATION_META}.
 *
 * Extracted so the two places that paint an operation — a tool ROW, and the
 * strip on a collapsed group's header — share one component instead of two
 * copies of "look up the meta, spread the tone, stamp `data-operation`". The
 * `data-operation` attribute is what a test and an inspector read the meaning
 * off, since a lucide class name changes with the icon rather than with what it
 * means.
 */
export function ToolOperationIcon({
  operation,
  className,
}: {
  operation: ToolOperation;
  className?: string;
}): React.JSX.Element {
  const meta = TOOL_OPERATION_META[operation];
  const Icon = meta.icon;
  return (
    <Icon
      aria-hidden="true"
      data-operation={operation}
      className={cn('size-3 shrink-0', meta.tone, className)}
    />
  );
}

/**
 * A tool row's leading glyph: WHAT the call did once it is settled, or HOW it
 * is going while that is still the news.
 *
 * Which of the two is not a style choice. A row whose result never came, or came
 * back an error, has a status worth a glyph of its own — while every settled row
 * in a finished transcript wore the same green check, which is a column of
 * identical ticks saying only "these all happened", something the reader could
 * already see. So `done` spends the glyph on the operation instead, and the
 * failure tones are untouched: an error keeps its own mark and its row keeps its
 * destructive border.
 *
 * Falls back to the status glyph when the call cannot be classified at all — an
 * unknown tool's row would otherwise lose its only leading mark, and a blank is
 * a worse answer than a check.
 */
export function ToolCallIcon({
  payload,
  status,
  className,
}: {
  /** The `tool_call` item's payload — classified here, not by the caller. */
  payload: unknown;
  status: BlockStatus;
  className?: string;
}): React.JSX.Element {
  const operation = status === 'done' ? toolOperationOf(payload) : null;
  if (operation === null) {
    return <BlockStatusIcon status={status} className={className} />;
  }
  return <ToolOperationIcon operation={operation} className={className} />;
}
