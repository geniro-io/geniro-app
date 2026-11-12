import { createPortal } from 'react-dom';

import { writeClipboard } from '../../clipboard';
import { PanelLinkRow } from '../../components/panel-link-row';
import { ContextMenu, useContextMenu } from '../../components/ui/context-menu';
import type { MenuGroup } from '../../components/ui/menu';
import { useLatestCallback } from '../../components/use-latest-callback';
import {
  type BrowserPaneControls,
  useBrowserPane,
} from './browser-pane-context';

const WEB_ADDRESS = /^https?:\/\//i;

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
  /** Render beside the link: the right-click menu, or nothing. */
  menu: React.ReactNode;
}

/**
 * The chat's rules for one link: a plain click opens a web address in the chat
 * browser while its pane is open, and a right-click offers both browsers and
 * copying. Where the chat has no browser, or the address is not web, it returns
 * no handlers and no menu, so the link keeps the system's behaviour.
 */
export function useChatLink(href: string | undefined): ChatLinkHandlers {
  const pane = useBrowserPane();
  const contextMenu = useContextMenu();
  const web = href !== undefined && WEB_ADDRESS.test(href) ? href : null;

  const onClick = useLatestCallback(
    (event: React.MouseEvent<HTMLAnchorElement>): void => {
      if (web === null || isModifiedClick(event)) {
        return;
      }
      if (openInChatBrowserByDefault(pane, web)) {
        event.preventDefault();
      }
    },
    [pane, web],
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

  if (pane === null || web === null) {
    return { menu: null };
  }
  return {
    onClick,
    onContextMenu: contextMenu.onContextMenu,
    // Portalled: a paragraph cannot hold the menu's `div`, and a transform or
    // containment on a transcript ancestor would capture the fixed panel.
    menu:
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
            document.body,
          ),
  };
}

function stopEvent(event: React.SyntheticEvent): void {
  event.stopPropagation();
}

/** An outward `<a>` in the chat, opened and right-clicked by {@link useChatLink}. */
export function ChatLink({
  href,
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
        target="_blank"
        rel="noreferrer"
        onClick={link.onClick}
        onContextMenu={link.onContextMenu}
      />
      {link.menu}
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
      {link.menu}
    </>
  );
}
