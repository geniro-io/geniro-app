import { Plus, Trash2 } from 'lucide-react';

import { formatTokens } from '../chats/agent-activity';
import { ErrorText } from './error-text';
import { ExpandableTextarea } from './expandable-textarea';
import { ReadOnlyText } from './read-only-text';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { cn } from './ui/utils';

/** A refusal about one field of a block, shown under that field. */
export interface InstructionBlockIssue {
  field: 'title' | 'text';
  message: string;
}

/** A block's measured size: its own text, as the daemon counted it. */
export interface InstructionBlockMeasure {
  chars: number;
  approxTokens: number;
}

const FLAT_FIELD =
  'rounded-control border-transparent bg-muted/40 shadow-none hover:border-field-border focus-visible:border-field-border';

/**
 * One block of instructions: an editable title, its size, a remove button and
 * its text. `headerExtra` sits beside the title and `children` under it, for
 * what a block reaches when the surface has an audience to pick.
 */
export function InstructionBlockCard({
  id,
  title,
  text,
  issues = [],
  size,
  sizeTitle,
  headerExtra,
  children,
  onTitleChange,
  onTextChange,
  onRemove,
}: {
  id: string;
  title: string;
  text: string;
  issues?: readonly InstructionBlockIssue[];
  size?: InstructionBlockMeasure;
  /** The tooltip on the size, saying who carries the block. */
  sizeTitle?: string;
  headerExtra?: React.ReactNode;
  children?: React.ReactNode;
  onTitleChange: (title: string) => void;
  onTextChange: (text: string) => void;
  onRemove: () => void;
}): React.JSX.Element {
  const at = (field: InstructionBlockIssue['field']): InstructionBlockIssue[] =>
    issues.filter((issue) => issue.field === field);
  return (
    <li
      data-slot="block-card"
      data-block-id={id}
      className="flex flex-col gap-3 rounded-card bg-card p-5 ring-1 ring-border">
      <div className="flex items-center gap-2">
        <Input
          id={`block-${id}-title`}
          aria-label="Block title"
          value={title}
          placeholder="Untitled block"
          aria-invalid={at('title').length > 0 || undefined}
          className={cn('h-8 flex-1 text-base font-semibold', FLAT_FIELD)}
          onChange={(event) => onTitleChange(event.target.value)}
        />
        {size === undefined || size.chars === 0 ? null : (
          <span
            data-slot="block-tokens"
            title={sizeTitle}
            className="shrink-0 text-sm text-muted-foreground tabular-nums">
            ~{formatTokens(size.approxTokens)} tokens
          </span>
        )}
        {headerExtra}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={`Remove block ${title.trim() || id}`}
          title="Remove block"
          className="size-8 shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          onClick={onRemove}>
          <Trash2 />
        </Button>
      </div>
      {at('title').map((issue) => (
        <ErrorText key={issue.message} className="text-xs">
          {issue.message}
        </ErrorText>
      ))}
      {children}
      <div className="[&_textarea]:border-transparent [&_textarea]:bg-muted/40 [&_textarea]:shadow-none [&_textarea:focus-visible]:border-field-border [&_textarea:hover]:border-field-border">
        <ExpandableTextarea
          id={`block-${id}-text`}
          title={title.trim() || 'Instruction block'}
          ariaLabel="Block text"
          value={text}
          rows={4}
          invalid={at('text').length > 0 || undefined}
          placeholder="Prefer short sentences. Cite the files you changed."
          onChange={onTextChange}
        />
      </div>
      {at('text').map((issue) => (
        <ErrorText key={issue.message} className="text-xs">
          {issue.message}
        </ErrorText>
      ))}
    </li>
  );
}

/**
 * One block shown as it stands, editable elsewhere: its title, a tag saying
 * where it lives, its size and the first lines of its text, the whole of it
 * in a read-only window. `children` sits under the title.
 */
export function ReadOnlyInstructionBlockCard({
  id,
  title,
  text,
  tag,
  size,
  sizeTitle,
  children,
}: {
  id: string;
  title: string;
  text: string;
  tag?: React.ReactNode;
  size?: InstructionBlockMeasure;
  sizeTitle?: string;
  children?: React.ReactNode;
}): React.JSX.Element {
  const name = title.trim() || 'Untitled block';
  return (
    <li
      data-slot="block-card"
      data-block-id={id}
      data-read-only="true"
      className="flex flex-col gap-2 rounded-card bg-muted/30 p-5 ring-1 ring-border">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-base font-semibold">
          {name}
        </span>
        {size === undefined || size.chars === 0 ? null : (
          <span
            data-slot="block-tokens"
            title={sizeTitle}
            className="shrink-0 text-sm text-muted-foreground tabular-nums">
            ~{formatTokens(size.approxTokens)} tokens
          </span>
        )}
        {tag}
      </div>
      {children}
      <ReadOnlyText title={name} text={text} slot="block-text" />
    </li>
  );
}

/** The blocks in order, a line when there are none, and the add button when blocks can be added here. */
export function InstructionBlockList({
  empty,
  emptyLabel,
  onAdd,
  addLabel = 'Add instruction block',
  children,
}: {
  empty: boolean;
  emptyLabel: string;
  onAdd?: () => void;
  addLabel?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div data-slot="instructions-card" className="flex flex-col gap-3">
      {empty ? (
        <p className="text-sm text-muted-foreground">{emptyLabel}</p>
      ) : (
        <ul className="flex flex-col gap-3">{children}</ul>
      )}
      {onAdd === undefined ? null : (
        <Button
          type="button"
          variant="ghost"
          className="h-8 self-start gap-2 rounded-control text-muted-foreground"
          onClick={onAdd}>
          <Plus aria-hidden="true" />
          {addLabel}
        </Button>
      )}
    </div>
  );
}
