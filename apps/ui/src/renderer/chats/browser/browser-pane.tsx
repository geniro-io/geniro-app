import {
  ArrowLeft,
  ArrowRight,
  Bot,
  MoreHorizontal,
  PictureInPicture2,
  Plus,
  RotateCw,
  Square,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import type {
  BrowserRunState,
  BrowserTabAction,
  BrowserTabState,
} from '../../../shared/contracts';
import { EmptyState } from '../../components/empty-state';
import { ErrorBanner } from '../../components/error-banner';
import { tabPanelId, TabStrip } from '../../components/tab-strip';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Menu, type MenuGroup } from '../../components/ui/menu';
import { useLatestCallback } from '../../components/use-latest-callback';
import { BrowserAddressField } from './browser-address-field';
import { BrowserNewTabPage } from './browser-new-tab-page';
import { BrowserAuthPrompt, BrowserLoadFailed } from './browser-tab-notice';
import { useBrowserState } from './use-browser-state';
import { useBrowserView } from './use-browser-view';

/** Below this width the toolbar keeps only back and the address. */
const COMPACT_WIDTH_PX = 380;

const TAB_LABEL_MAX = 22;

function hostOf(address: string): string {
  try {
    return new URL(address).host;
  } catch {
    return address;
  }
}

function tabLabel(tab: BrowserTabState): string {
  const text = tab.title !== '' ? tab.title : hostOf(tab.url);
  const label = text === '' ? 'New tab' : text;
  return label.length > TAB_LABEL_MAX
    ? `${label.slice(0, TAB_LABEL_MAX - 1)}…`
    : label;
}

function isBlank(tab: BrowserTabState): boolean {
  return tab.url === '' || tab.url === 'about:blank';
}

function menuGroups(
  tab: BrowserTabState | null,
  poppedOut: boolean,
): MenuGroup[] {
  const forTab = tab === null;
  return [
    {
      items: [
        { value: 'devtools', label: 'Open DevTools', disabled: forTab },
        { value: 'clearCookies', label: 'Clear cookies', disabled: forTab },
        {
          value: 'openExternal',
          label: 'Open in system browser',
          disabled: forTab || isBlank(tab),
        },
        {
          value: 'copyUrl',
          label: 'Copy address',
          disabled: forTab || isBlank(tab),
        },
      ],
    },
    {
      items: [
        {
          value: poppedOut ? 'dock' : 'popOut',
          label: poppedOut ? 'Dock back' : 'Pop out',
        },
      ],
    },
    {
      items: [
        {
          value: 'close',
          label: 'Close tab',
          tone: 'destructive',
          disabled: forTab,
        },
      ],
    },
  ];
}

const TAB_ACTIONS: readonly BrowserTabAction[] = [
  'devtools',
  'clearCookies',
  'openExternal',
  'copyUrl',
];

function isTabAction(value: string): value is BrowserTabAction {
  return (TAB_ACTIONS as readonly string[]).includes(value);
}

const EMPTY_RUN = (runId: string): BrowserRunState => ({
  runId,
  tabs: [],
  activeTabId: null,
  poppedOut: false,
  recent: [],
});

/**
 * One chat's in-app browser: tabs, address bar and the page itself, which is a
 * native view main places over this pane's placeholder. Anything the pane must
 * draw over the page (a failure, a sign-in, the start page) hides the view.
 */
export function BrowserPane({
  runId,
  visible,
  onClose,
  chatTitle = 'Chat',
}: {
  runId: string;
  visible: boolean;
  onClose: () => void;
  chatTitle?: string;
}): React.JSX.Element | null {
  const read = useBrowserState(runId);
  const state = read ?? EMPTY_RUN(runId);
  const tabs = state.tabs;
  const active =
    tabs.find((tab) => tab.id === state.activeTabId) ?? tabs[0] ?? null;
  const [menuOpen, setMenuOpen] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [compact, setCompact] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const placeholderRef = useRef<HTMLDivElement | null>(null);
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);

  const startPage = active === null || (isBlank(active) && !active.error);
  const noticeShown =
    active !== null && (active.error !== null || active.authRequest !== null);
  const wantsView =
    visible && read !== null && !state.poppedOut && !startPage && !noticeShown;
  const { still } = useBrowserView(runId, placeholderRef, wantsView);

  useEffect(() => {
    const element = rootRef.current;
    if (element === null || typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver(() =>
      setCompact(
        element.clientWidth > 0 && element.clientWidth < COMPACT_WIDTH_PX,
      ),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [visible]);

  const attempt = useLatestCallback((work: Promise<unknown>): void => {
    work.then(
      () => setFailure(null),
      (error: unknown) =>
        setFailure(error instanceof Error ? error.message : String(error)),
    );
  }, []);

  const openAddress = useLatestCallback(
    (input: string): void => {
      if (active !== null) {
        attempt(window.geniro.browserNavigate(runId, active.id, input));
        return;
      }
      attempt(
        window.geniro
          .browserOpenTab(runId, null)
          .then((tabId) => window.geniro.browserNavigate(runId, tabId, input)),
      );
    },
    [runId, active],
  );

  const onMenuSelect = useLatestCallback(
    (value: string): void => {
      setMenuOpen(false);
      if (value === 'popOut') {
        attempt(window.geniro.browserPopOut(runId, chatTitle));
      } else if (value === 'dock') {
        attempt(window.geniro.browserDock(runId));
      } else if (active === null) {
        return;
      } else if (value === 'close') {
        attempt(window.geniro.browserCloseTab(runId, active.id));
      } else if (isTabAction(value)) {
        attempt(window.geniro.browserTabAction(runId, active.id, value));
      }
    },
    [runId, active, chatTitle],
  );

  if (!visible) {
    return null;
  }

  const history = (action: 'back' | 'forward' | 'reload' | 'stop'): void => {
    if (active !== null) {
      attempt(window.geniro.browserHistory(runId, active.id, action));
    }
  };

  const header = (
    <div className="flex shrink-0 items-center gap-1 border-b border-border pr-2 pl-3">
      {tabs.length === 0 ? (
        <span className="min-w-0 flex-1 text-sm font-medium">Browser</span>
      ) : (
        <TabStrip
          className="min-w-0 flex-1"
          label="Browser tabs"
          idPrefix={`browser-${runId}`}
          tabs={tabs.map((tab) => ({ id: tab.id, label: tabLabel(tab) }))}
          value={active?.id ?? ''}
          onSelect={(tabId) =>
            attempt(window.geniro.browserSelectTab(runId, tabId))
          }
        />
      )}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7 text-muted-foreground"
        aria-label="New tab"
        title="New tab"
        onClick={() => attempt(window.geniro.browserOpenTab(runId, null))}>
        <Plus />
      </Button>
      <span className="relative inline-flex">
        <Button
          ref={menuTriggerRef}
          type="button"
          variant="ghost"
          size="icon"
          data-menu-trigger
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          className="size-7 text-muted-foreground"
          aria-label="Tab menu"
          title="Tab menu"
          onClick={() => setMenuOpen((wasOpen) => !wasOpen)}>
          <MoreHorizontal />
        </Button>
        <Menu
          open={menuOpen}
          side="bottom"
          align="end"
          anchor="viewport"
          triggerRef={menuTriggerRef}
          groups={menuGroups(active, state.poppedOut)}
          onSelect={onMenuSelect}
          onClose={() => setMenuOpen(false)}
        />
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7 text-muted-foreground"
        aria-label="Close browser"
        title="Close browser"
        onClick={onClose}>
        <X />
      </Button>
    </div>
  );

  const loading = active?.loading ?? false;
  const reloadButton = (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-8 text-muted-foreground"
      aria-label={loading ? 'Stop loading' : 'Reload'}
      title={loading ? 'Stop loading' : 'Reload'}
      disabled={active === null}
      onClick={() => history(loading ? 'stop' : 'reload')}>
      {loading ? <Square className="size-3.5" /> : <RotateCw />}
    </Button>
  );

  return (
    <div
      ref={rootRef}
      data-slot="browser-pane"
      className="flex h-full min-h-0 flex-col bg-background">
      {header}
      <div className="flex shrink-0 items-center gap-1 p-2">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 text-muted-foreground"
          aria-label="Back"
          title="Back"
          disabled={active === null || !active.canGoBack}
          onClick={() => history('back')}>
          <ArrowLeft />
        </Button>
        {compact ? null : (
          <>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8 text-muted-foreground"
              aria-label="Forward"
              title="Forward"
              disabled={active === null || !active.canGoForward}
              onClick={() => history('forward')}>
              <ArrowRight />
            </Button>
            {reloadButton}
          </>
        )}
        <BrowserAddressField
          className="flex-1"
          address={active?.url ?? ''}
          loading={loading}
          onSubmit={openAddress}
        />
      </div>
      {active === null ||
      (active.ownCookiesLabel === null && active.openedBy === null) ? null : (
        <div
          data-slot="browser-tab-marks"
          className="flex shrink-0 flex-wrap items-center gap-1.5 px-2 pb-2">
          {active.ownCookiesLabel === null ? null : (
            <Badge variant="muted">
              {active.ownCookiesLabel} · own cookies
            </Badge>
          )}
          {active.openedBy === null ? null : (
            <Badge variant="outline" title={`Opened by ${active.openedBy}`}>
              <Bot aria-hidden="true" />
              {active.openedBy}
            </Badge>
          )}
        </div>
      )}
      {active === null || active.drivenBy === null ? null : (
        <div
          data-slot="browser-driving-banner"
          role="status"
          className="flex shrink-0 items-center gap-2 border-y border-border bg-muted px-3 py-1.5 text-sm">
          <Bot className="size-4 shrink-0 text-primary" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">
            {active.drivenBy} is driving this tab
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7"
            onClick={() =>
              attempt(window.geniro.browserStopAgent(runId, active.id))
            }>
            Stop
          </Button>
        </div>
      )}
      {failure === null ? null : (
        <ErrorBanner
          message={failure}
          size="sm"
          onDismiss={() => setFailure(null)}
        />
      )}
      <div
        ref={placeholderRef}
        role="tabpanel"
        id={
          active === null
            ? undefined
            : tabPanelId(`browser-${runId}`, active.id)
        }
        className="relative min-h-0 flex-1 overflow-y-auto border-t border-border">
        {still === null ? null : (
          <img
            src={still}
            alt=""
            data-slot="browser-still"
            className="size-full object-cover object-left-top"
          />
        )}
        {active?.authRequest ? (
          <BrowserAuthPrompt
            request={active.authRequest}
            onAnswer={(credentials) =>
              attempt(
                window.geniro.browserAnswerAuth(runId, active.id, credentials),
              )
            }
          />
        ) : active?.error ? (
          <BrowserLoadFailed
            error={active.error}
            onContinueInsecure={() =>
              attempt(window.geniro.browserContinueInsecure(runId, active.id))
            }
            onReload={() => history('reload')}
          />
        ) : state.poppedOut ? (
          <EmptyState
            icon={<PictureInPicture2 />}
            actions={
              <Button
                type="button"
                variant="outline"
                onClick={() => attempt(window.geniro.browserDock(runId))}>
                Dock back
              </Button>
            }>
            Open in its own window
          </EmptyState>
        ) : startPage ? (
          <BrowserNewTabPage recent={state.recent} onOpen={openAddress} />
        ) : null}
      </div>
    </div>
  );
}
