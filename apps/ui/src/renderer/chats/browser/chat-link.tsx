import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

import { writeClipboard } from '../../clipboard';
import { PanelLinkRow } from '../../components/panel-link-row';
import { ContextMenu, useContextMenu } from '../../components/ui/context-menu';
import type { MenuGroup } from '../../components/ui/menu';
import { POPOVER_PANEL_SELECTOR } from '../../components/ui/popover';
import { useLatestCallback } from '../../components/use-latest-callback';
import { localPathOf } from '../markdown-paths';
import { pathToOpen, useShowInFinder } from '../use-show-in-finder';
import {
  type BrowserPaneControls,
  useBrowserPane,
} from './browser-pane-context';

const WEB_ADDRESS = /^https?:\/\//i;

/** How long a path link's failure stays beside it. */
export const PATH_LINK_NOTICE_MS = 6000;

/** The local file or folder a link's address names, or null when it names none. */
export function localPathOfHref(href: string | undefined): string | null {
  if (href === undefined || !href.startsWith('/') || href.startsWith('//')) {
    return null;
  }
  return pathToOpen(localPathOf(href));
}

const LINK_MENU: MenuGroup[] = [
  {
    items: [
      { value: 'pane', label: 'Open in Geniro browser' },
      { value: 'system', label: 'Open in system browser' },
    ],
  },
  { items: [{ value: 'copy', label: 'Copy link' }] },
];

/**
 * Opens a web address in the chat's browser when its pane is open, and returns
 * whether it did; false leaves the link to the system browser.
 */
export function openInChatBrowserByDefault(
  pane: BrowserPaneControls | null,
  href: string,
): boolean {
  if (pane === null || !WEB_ADDRESS.test(href) || !pane.isOpen()) {
    return false;
  }
  pane.openUrl(href);
  return true;
}

function isModifiedClick(event: React.MouseEvent): boolean {
  return (
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  );
}

export interface ChatLinkHandlers {
  onClick?: (event: React.MouseEvent<HTMLAnchorElement>) => void;
  onContextMenu?: (event: React.MouseEvent) => void;
  title?: string;
  /** Render beside the link: its right-click menu, why its path was not shown, or nothing. */
  beside: React.ReactNode;
}

/**
 * The chat's rules for one link: a plain click opens a web address in the chat
 * browser while its pane is open, and a right-click offers both browsers and
 * copying; a plain click on a local path shows it in Finder. Where the chat has no
 * browser, or the address is neither web nor a path, it returns no handlers and
 * nothing beside, so the link keeps the system's behaviour.
 */
export function useChatLink(href: string | undefined): ChatLinkHandlers {
  const pane = useBrowserPane();
  const contextMenu = useContextMenu();
  const finder = useShowInFinder();
  const [menuHost, setMenuHost] = useState<Element | null>(null);
  const web = href !== undefined && WEB_ADDRESS.test(href) ? href : null;
  const localPath = web === null ? localPathOfHref(href) : null;

  useEffect(() => {
    if (finder.failure === null) {
      return;
    }
    const timer = setTimeout(finder.clearFailure, PATH_LINK_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [finder.failure, finder.clearFailure]);

  // Inside a popover the menu must stay in its panel: the popover closes on a
  // press outside it, which would unmount the link before the item's click.
  const onContextMenu = useLatestCallback(
    (event: React.MouseEvent): void => {
      setMenuHost(
        event.currentTarget instanceof Element
          ? event.currentTarget.closest(POPOVER_PANEL_SELECTOR)
          : null,
      );
      contextMenu.onContextMenu(event);
    },
    [contextMenu.onContextMenu],
  );

  const onClick = useLatestCallback(
    (event: React.MouseEvent<HTMLAnchorElement>): void => {
      if (localPath !== null) {
        event.preventDefault();
        if (!isModifiedClick(event)) {
          finder.show(localPath);
        }
        return;
      }
      if (web === null || isModifiedClick(event)) {
        return;
      }
      if (openInChatBrowserByDefault(pane, web)) {
        event.preventDefault();
      }
    },
    [pane, web, localPath, finder.show],
  );

  const choose = useLatestCallback(
    (value: string): void => {
      if (web === null) {
        return;
      }
      if (value === 'pane') {
        pane?.openUrl(web);
      } else if (value === 'system') {
        window.open(web, '_blank', 'noopener');
      } else if (value === 'copy') {
        void writeClipboard(web);
      }
    },
    [pane, web],
  );

  if (localPath !== null) {
    return {
      onClick,
      title: 'Show in Finder',
      beside:
        finder.failure === null ? null : (
          <span role="status" className="ml-1 text-xs text-destructive">
            Not shown in Finder: {finder.failure}
          </span>
        ),
    };
  }
  if (pane === null || web === null) {
    return { beside: null };
  }
  return {
    onClick,
    onContextMenu,
    // Portalled: a paragraph cannot hold the menu's `div`, and a transform or
    // containment on a transcript ancestor would capture the fixed panel.
    beside:
      contextMenu.point === null
        ? null
        : createPortal(
            <div
              className="contents"
              onClick={stopEvent}
              onContextMenu={stopEvent}>
              <ContextMenu
                point={contextMenu.point}
                groups={LINK_MENU}
                onSelect={choose}
                onClose={contextMenu.close}
              />
            </div>,
            menuHost ?? document.body,
          ),
  };
}

function stopEvent(event: React.SyntheticEvent): void {
  event.stopPropagation();
}

/** An outward `<a>` in the chat, opened and right-clicked by {@link useChatLink}. */
export function ChatLink({
  href,
  title,
  ...anchor
}: Omit<
  React.AnchorHTMLAttributes<HTMLAnchorElement>,
  'onClick' | 'onContextMenu'
>): React.JSX.Element {
  const link = useChatLink(href);
  return (
    <>
      <a
        {...anchor}
        href={href}
        title={title ?? link.title}
        target="_blank"
        rel="noreferrer"
        onClick={link.onClick}
        onContextMenu={link.onContextMenu}
      />
      {link.beside}
    </>
  );
}

/** A side-panel link row whose press and right-click follow {@link useChatLink}. */
export function ChatPanelLinkRow(
  props: React.ComponentProps<typeof PanelLinkRow>,
): React.JSX.Element {
  const link = useChatLink(props.href);
  return (
    <>
      <PanelLinkRow
        {...props}
        onClick={link.onClick}
        onContextMenu={link.onContextMenu}
      />
      {link.beside}
    </>
  );
}
