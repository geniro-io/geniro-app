import { AnsiText } from '../components/ui/ansi-text';
import { Button } from '../components/ui/button';
import { cn } from '../components/ui/utils';
import type {
  MonitorEnd,
  MonitorEntry,
  MonitorNotice,
} from './monitor-payload';
import { useThreadFlag } from './thread-ui-memory';
import { AgentName, PickedBackUpLine } from './wake-divider';

/** How a monitor's command ended, in the words a reader expects. */
export function monitorEndText(end: MonitorEnd): string {
  switch (end.kind) {
    case 'exit':
      return end.code === undefined ? 'exited' : `exit code ${end.code}`;
    case 'signal':
      return end.signal === undefined
        ? 'killed by a signal'
        : `killed by ${end.signal}`;
    case 'timeout':
      return 'timed out';
    case 'stopped':
      return 'stopped';
    case 'flooded':
      return 'flooded';
    case 'interrupted':
      return 'interrupted';
  }
}

/** An ending the reader should not skim past: the command did not finish cleanly. */
function isBadEnd(end: MonitorEnd): boolean {
  return end.kind === 'exit' ? end.code !== 0 : end.kind !== 'stopped';
}

function MonitorOutput({
  entry,
  memoryKey,
}: {
  entry: MonitorEntry;
  memoryKey: string;
}): React.JSX.Element {
  const [open, setOpen] = useThreadFlag(memoryKey, false);
  return (
    <div className="flex w-full flex-col items-center gap-1">
      <Button
        type="button"
        variant="link"
        className="h-auto p-0 text-xs max-sm:min-h-11"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}>
        Output
      </Button>
      {open ? (
        <pre
          data-slot="monitor-output"
          className="max-h-60 w-full overflow-auto rounded-md bg-muted px-2 py-1.5 font-mono text-xs whitespace-pre-wrap text-foreground">
          <AnsiText text={entry.lines.join('\n')} />
          {entry.omitted > 0 ? (
            <span className="block text-muted-foreground">
              … {entry.omitted} more {entry.omitted === 1 ? 'line' : 'lines'}{' '}
              not delivered
            </span>
          ) : null}
        </pre>
      ) : null}
    </div>
  );
}

/**
 * A monitor's batch that started a turn of the agent's own: the agent picking
 * its work back up, with the delivered output folded under it.
 */
export function MonitorDivider({
  agent,
  entry,
  memoryKey,
}: {
  /** The woken agent's display name, or null where it has none. */
  agent: string | null;
  entry: MonitorEntry;
  memoryKey: string;
}): React.JSX.Element {
  return (
    <div data-slot="monitor-notice" className="flex w-full flex-col">
      <PickedBackUpLine slot="monitor-divider">
        <AgentName name={agent} /> picked back up — {entry.description} ·
        monitor {entry.id}
        {entry.end === null ? null : (
          <>
            {' · '}
            <span
              data-slot="monitor-end"
              className={cn(isBadEnd(entry.end) && 'font-semibold')}>
              {monitorEndText(entry.end)}
            </span>
          </>
        )}
      </PickedBackUpLine>
      {entry.lines.length + entry.omitted > 0 ? (
        <MonitorOutput entry={entry} memoryKey={memoryKey} />
      ) : null}
    </div>
  );
}

/** A monitor that ended without waking the agent: stopped by it, or with the thread. */
export function MonitorQuietNote({
  entry,
}: {
  entry: MonitorEntry;
}): React.JSX.Element {
  const tail =
    entry.end === null || entry.end.kind === 'stopped'
      ? ' stopped'
      : ` · ${monitorEndText(entry.end)}`;
  return (
    <p
      data-slot="monitor-note"
      className="w-full py-1 text-center text-xs text-muted-foreground">
      {entry.description} · monitor {entry.id}
      {tail}
    </p>
  );
}

/**
 * What a monitor notice row draws: nothing for a monitor that only started (the
 * tool call row already shows its command), a divider per batch that woke the
 * agent, a quiet note per ending that did not.
 */
export function MonitorNoticeRow({
  notice,
  agent,
  memoryKey,
}: {
  notice: MonitorNotice;
  agent: string | null;
  /** Prefix the folds of this row are remembered under. */
  memoryKey: string;
}): React.JSX.Element | null {
  const shown = notice.monitors.filter((entry) => entry.event !== 'start');
  if (shown.length === 0) {
    return null;
  }
  return (
    <>
      {shown.map((entry, index) =>
        notice.woke ? (
          <MonitorDivider
            key={`${entry.id}:${index}`}
            agent={agent}
            entry={entry}
            memoryKey={`${memoryKey}:${index}`}
          />
        ) : (
          <MonitorQuietNote key={`${entry.id}:${index}`} entry={entry} />
        ),
      )}
    </>
  );
}
