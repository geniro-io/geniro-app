import {
  ArrowDownUp,
  Code,
  Compass,
  Cookie,
  FileText,
  Globe,
  Keyboard,
  ListChecks,
  MousePointerClick,
  PanelTop,
  Tag,
  Terminal,
  X,
} from 'lucide-react';

import { Button } from '../components/ui/button';
import { Spinner } from '../components/ui/spinner';
import { cn } from '../components/ui/utils';
import type { BlockStatus } from './block-shell';
import { useBrowserPane } from './browser/browser-pane-context';
import { type GeniroBrowserTool, geniroBrowserToolOf } from './geniro-tool';
import {
  recordOf,
  refusalReason,
  resultTextOf,
  toolCallArgsOf,
} from './tool-result-text';
import { plural } from './tool-row-parts';
import type { ToolPair } from './transcript-groups';
import { payloadString } from './transcript-payload';

/** What a browser tool call asked and got back, read off its untyped payloads. */
export interface BrowserToolEntry {
  tool: GeniroBrowserTool;
  /** The address a call opened or navigated to, as `host[:port]`. */
  host: string | null;
  /** The tab the call named, or the one its result says it opened. */
  tab: string | null;
  /** The element ref (`e12`) the call named. */
  ref: string | null;
  /** The key `browser_press` sent. */
  key: string | null;
  /** How many cookies `browser_set_cookies` set; their values are never read. */
  cookies: number | null;
  /** The label of an own-cookie tab `browser_open` made. */
  ownLabel: string | null;
  /** The name a label call gave its tab. */
  name: string | null;
  /** The open was put to the user as a card instead of being run. */
  waitingForApproval: boolean;
  /** The first line of a refusal; null when the call did not fail. */
  failure: string | null;
}

const WAITING_FOR_APPROVAL = 'Waiting for the user to approve';

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function hostOf(url: string | null): string | null {
  if (url === null) {
    return null;
  }
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/**
 * The browser row a tool pair draws, or null when the pair is not one of the
 * browser tools of this run's own server or its arguments cannot be read — the
 * caller then draws the ordinary tool row.
 *
 * TWIN PARSER: the argument names of the schemas in
 * `apps/daemon/src/v1/mcp/tools/browser-<tool>/` (`url`, `tab`, `ref`, `key`,
 * `cookies`, `ownCookies.label`) and the `Tab: <id>` line
 * `browserDoneText` (`browser-shared/browser-outcome.ts`) adds, and the
 * `Waiting for the user to approve <host>` sentence of `browserStoppedText`.
 */
export function browserToolEntryOf(pair: ToolPair): BrowserToolEntry | null {
  const name = payloadString(pair.call.payload, 'name') ?? '';
  const tool = geniroBrowserToolOf(name, pair.call.runId);
  if (tool === null) {
    return null;
  }
  const args = toolCallArgsOf(pair.call.payload);
  if (args === null) {
    return null;
  }
  const resultPayload = recordOf(pair.result?.payload);
  const text = resultTextOf(resultPayload?.result)?.trim() ?? '';
  const failed = resultPayload?.isError === true;
  const ownCookies = recordOf(args.ownCookies);
  const cookies = Array.isArray(args.cookies) ? args.cookies.length : null;
  return {
    tool,
    host: hostOf(readString(args.url)),
    tab:
      readString(args.tab) ??
      (failed ? null : (/(?:^|\n)Tab: (t\d+)\b/.exec(text)?.[1] ?? null)),
    ref: readString(args.ref),
    key: readString(args.key),
    cookies,
    ownLabel: readString(ownCookies?.label),
    name: readString(args.name),
    waitingForApproval: text.startsWith(WAITING_FOR_APPROVAL),
    failure: failed && text !== '' ? refusalReason(text) : null,
  };
}

const TOOL_ICON = {
  browser_open: Globe,
  browser_navigate: Compass,
  browser_snapshot: FileText,
  browser_click: MousePointerClick,
  browser_type: Keyboard,
  browser_press: Keyboard,
  browser_select: ListChecks,
  browser_scroll: ArrowDownUp,
  browser_console: Terminal,
  browser_evaluate: Code,
  browser_tabs: PanelTop,
  browser_label_tab: Tag,
  browser_close: X,
  browser_set_cookies: Cookie,
  browser_get_cookies: Cookie,
  browser_clear_cookies: Cookie,
} as const satisfies Record<GeniroBrowserTool, unknown>;

/** The row's words: a verb, what it acted on, and a muted aside. */
function wordsOf(
  entry: BrowserToolEntry,
  running: boolean,
): { verb: string; object: string | null; aside: string | null } {
  const on = (done: string, doing: string): string => (running ? doing : done);
  switch (entry.tool) {
    case 'browser_open':
      if (entry.waitingForApproval) {
        return {
          verb: 'Asked to open',
          object: entry.host,
          aside: 'waiting for approval',
        };
      }
      return {
        verb: on('Opened', 'Opening'),
        object: entry.host,
        aside:
          entry.ownLabel === null ? null : `${entry.ownLabel} · own cookies`,
      };
    case 'browser_navigate':
      if (entry.waitingForApproval) {
        return {
          verb: 'Asked to navigate to',
          object: entry.host,
          aside: 'waiting for approval',
        };
      }
      return {
        verb: on('Navigated to', 'Navigating to'),
        object: entry.host,
        aside: null,
      };
    case 'browser_snapshot':
      return {
        verb: on('Read the page', 'Reading the page'),
        object: null,
        aside: null,
      };
    case 'browser_click':
      return {
        verb: on('Clicked', 'Clicking'),
        object: entry.ref,
        aside: null,
      };
    case 'browser_type':
      return {
        verb: on('Typed into', 'Typing into'),
        object: entry.ref,
        aside: null,
      };
    case 'browser_press':
      return {
        verb: on('Pressed', 'Pressing'),
        object: entry.key,
        aside: null,
      };
    case 'browser_select':
      return {
        verb: on('Selected in', 'Selecting in'),
        object: entry.ref,
        aside: null,
      };
    case 'browser_scroll':
      return {
        verb: on('Scrolled', 'Scrolling'),
        object: entry.ref,
        aside: null,
      };
    case 'browser_console':
      return {
        verb: on('Read the console', 'Reading the console'),
        object: null,
        aside: null,
      };
    case 'browser_evaluate':
      return {
        verb: on('Ran a script in the page', 'Running a script in the page'),
        object: null,
        aside: null,
      };
    case 'browser_tabs':
      return {
        verb: on('Listed tabs', 'Listing tabs'),
        object: null,
        aside: null,
      };
    case 'browser_label_tab':
      return {
        verb: on('Labelled tab', 'Labelling tab'),
        object: entry.tab,
        aside: entry.name,
      };
    case 'browser_close':
      return {
        verb: on('Closed tab', 'Closing tab'),
        object: entry.tab,
        aside: null,
      };
    case 'browser_set_cookies':
      return {
        verb:
          entry.cookies === null
            ? on('Set cookies', 'Setting cookies')
            : `${on('Set', 'Setting')} ${plural(entry.cookies, 'cookie')}`,
        object: null,
        aside: '‹cookie› values hidden',
      };
    case 'browser_get_cookies':
      return {
        verb: on('Read cookies', 'Reading cookies'),
        object: null,
        aside: null,
      };
    case 'browser_clear_cookies':
      return {
        verb: on('Cleared cookies', 'Clearing cookies'),
        object: null,
        aside: null,
      };
  }
}

/**
 * One in-app browser tool call as a single compact line inside the
 * transcript's tool group — "Opened staging.acme.dev", "Clicked e12" — with a
 * way back to the tab in the chat's browser pane while that tab is still open;
 * a close has none. Never the text typed or a cookie value: the row names what
 * was acted on, not what was sent.
 */
export function BrowserToolRow({
  entry,
  status,
}: {
  entry: BrowserToolEntry;
  status: BlockStatus;
}): React.JSX.Element {
  const pane = useBrowserPane();
  const running = status === 'running';
  const failed = status === 'error';
  const Icon = TOOL_ICON[entry.tool];
  const words = wordsOf(entry, running);
  return (
    <div
      data-role="browser-tool"
      data-browser-tool={entry.tool}
      className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 py-0.5 text-xs text-muted-foreground">
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      <span className={cn('font-medium', failed && 'text-destructive')}>
        {words.verb}
      </span>{' '}
      {words.object === null ? null : (
        <>
          <span className="min-w-0 truncate font-mono text-primary">
            {words.object}
          </span>{' '}
        </>
      )}
      {words.aside === null || failed ? null : (
        <>
          <span className="text-muted-foreground/70">({words.aside})</span>{' '}
        </>
      )}
      {failed && entry.failure !== null ? (
        <>
          <span className="min-w-0 truncate text-muted-foreground/70">
            {entry.failure}
          </span>{' '}
        </>
      ) : null}
      {running ? <Spinner /> : null}
      {status === 'stopped' ? (
        <span className="text-muted-foreground/70">no result</span>
      ) : null}
      {pane === null || running || entry.tool === 'browser_close' ? null : (
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto px-1 py-0 text-xs"
          onClick={() => pane.openPane(entry.tab)}>
          Show in browser
        </Button>
      )}
    </div>
  );
}
