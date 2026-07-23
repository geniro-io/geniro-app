import type { ChatApprovalMode, CliKind } from '../../shared/contracts';
import { Badge } from '../components/ui/badge';
import { Select } from '../components/ui/select';
import { cn } from '../components/ui/utils';

/** Display labels for the chat approval modes (order = menu order). */
const MODE_LABELS: readonly { value: ChatApprovalMode; label: string }[] = [
  { value: 'ask', label: 'ask' },
  { value: 'acceptEdits', label: 'accept edits' },
  { value: 'plan', label: 'plan' },
  { value: 'auto', label: 'auto-approve' },
];

/**
 * The composer's tool-approval chip. Cursor chats are pinned to auto-approve
 * (cursor-agent has no approval callback) and render as a hinted badge, never
 * a select. Claude chats offer ask / accept edits / plan / auto-approve, with
 * `plan` hidden unless the installed CLI probed pass (no dead UI) — a run
 * already stored on `plan` keeps its option visible so the select never lies.
 * A legacy run whose approval is null shows a one-way "cli default"
 * placeholder until a mode is picked.
 */
export function ApprovalModeSelect({
  agentKind,
  value,
  planSupported,
  disabled = false,
  onChange,
  className,
}: {
  agentKind: CliKind;
  /** Current mode; null = legacy run created before the selector existed. */
  value: ChatApprovalMode | null;
  planSupported: boolean;
  /** Locked while a turn is running (matches the daemon's 409 RUN_BUSY). */
  disabled?: boolean;
  onChange: (mode: ChatApprovalMode) => void;
  className?: string;
}): React.JSX.Element {
  if (agentKind === 'cursor-agent') {
    return (
      <Badge
        variant="muted"
        title="cursor-agent has no approval callback — cursor chats run auto-approve"
        className={cn('h-8 gap-1.5 rounded-lg px-2.5 font-medium', className)}>
        auto-approve
      </Badge>
    );
  }
  const options = MODE_LABELS.filter(
    (mode) => mode.value !== 'plan' || planSupported || value === 'plan',
  );
  return (
    <Select
      value={value ?? ''}
      disabled={disabled}
      aria-label="Tool-approval mode"
      title={
        disabled
          ? 'The approval mode is locked while a turn is running'
          : 'Tool-approval mode'
      }
      className={cn(
        'h-8 w-auto min-w-0 rounded-lg border-0 bg-transparent px-2.5 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground',
        className,
      )}
      onChange={(event) => {
        if (event.target.value !== '') {
          onChange(event.target.value as ChatApprovalMode);
        }
      }}>
      {value === null ? <option value="">cli default</option> : null}
      {options.map((mode) => (
        <option key={mode.value} value={mode.value}>
          {mode.label}
        </option>
      ))}
    </Select>
  );
}
