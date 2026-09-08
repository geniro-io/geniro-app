import { cn } from '../components/ui/utils';
import { labelDotClass } from './task-labels';

/**
 * One piece of a card's metadata, in the ONE shape all of them wear.
 *
 * Linear's board card is the reference, given as one ("хороший пример дизайна
 * на список задач. Сделай также"), and this is the half of it that does the
 * work: priority, labels, the branch and the due date are drawn as the SAME
 * object — a neutral bordered pill, a glyph or a coloured dot, then a word — so
 * a card's metadata reads as one row of tags rather than as four unrelated
 * fragments. Before it, each of those was its own arrangement of a small icon
 * and some muted text, which is why a label was indistinguishable from a date.
 *
 * The pill is NEUTRAL and the colour rides on the mark inside it — again
 * Linear's choice, and the right one at this size: a card carries up to five of
 * these, and five tinted pills out-shout the title, which is the thing a reader
 * is actually scanning for. It is also what keeps a coloured dot meaning
 * "which label" rather than competing with the priority's own hue.
 */
export function TaskChip({
  tone,
  title,
  className,
  children,
}: {
  /** `alarm` is for a fact that is WRONG rather than merely coloured. */
  tone?: 'alarm';
  title?: string;
  className?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <span
      data-slot="task-chip"
      title={title}
      className={cn(
        'inline-flex min-w-0 shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] leading-4',
        tone === 'alarm'
          ? 'border-destructive/30 bg-destructive/10 text-destructive'
          : 'border-border bg-muted/50 text-muted-foreground',
        className,
      )}>
      {children}
    </span>
  );
}

/**
 * A label, which is a {@link TaskChip} whose mark is the label's own colour.
 *
 * The colour is DERIVED from the text (see `labelColor`) — the daemon stores
 * none — so the same label is the same colour on every card, in every project,
 * with nothing to store or migrate.
 *
 * It went through a tinted-pill form first, which was a correction to a worse
 * one (a bare 6px dot beside muted text, REPORTED as "какие-то кривые и
 * непонятные") and is now itself corrected: with the branch and the due date
 * drawn as pills too, tinting only the labels made them the loudest thing on a
 * card again. The dot is what says WHICH label; the pill is what says it is a
 * label at all.
 */
export function TaskLabel({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  /** A trailing control, for the editor's remove button. */
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <TaskChip className={cn('text-foreground/80', className)}>
      <span
        className={cn('size-1.5 shrink-0 rounded-full', labelDotClass(label))}
        aria-hidden
      />
      <span className="truncate">{label}</span>
      {children}
    </TaskChip>
  );
}
