import { Bookmark, Plus, SlidersHorizontal } from 'lucide-react';
import * as React from 'react';

import type { RunConfig } from '../../shared/contracts';
import { Button } from '../components/ui/button';
import { Menu } from '../components/ui/menu';
import { workflowSlugOf } from './composer-values';
import { shortenPath } from './directory-select';

/**
 * The two rows that are commands rather than configurations. Prefixed so they
 * cannot collide with a configuration id, which is a UUID and holds no colon.
 */
const NEW_CONFIG = 'action:new-configuration';
const MANAGE_CONFIGS = 'action:manage-configurations';

/** How long the menu survives the pointer leaving, so the 6px gap is crossable. */
const CLOSE_DELAY_MS = 180;

/**
 * The sidebar's `+`: one click starts a new thread, hovering offers the saved
 * setups to start it from.
 *
 * A split control rather than two buttons. The `+` keeps its one-click meaning —
 * the common act stays the cheapest — while the configurations, which ask
 * *which one?*, live in the menu that the same button reveals on hover. That
 * replaces a second, always-visible button beside it: the configurations are a way of
 * starting a new chat, so hanging them off the control that starts one puts
 * them where the user is already aiming. That holds for a pointer that can
 * hover; a touch screen, or any screen narrower than `sm`, also gets a
 * bookmark button beside the `+` that opens the same menu.
 *
 * Creating and managing are ROWS in that menu rather than another button, for
 * the same reason — everything about "how does this new chat start" is reached
 * from one place.
 */
export function NewChatButton({
  configs,
  onNewChat,
  onApply,
  onCreate,
  onManage,
}: {
  configs: readonly RunConfig[];
  /** Plain click: the ordinary new thread, with no question attached. */
  onNewChat: () => void;
  onApply: (config: RunConfig) => void;
  onCreate: () => void;
  onManage: () => void;
}): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const closeTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * The kind of pointer that last reached the button. A tap on a phone is
   * followed by compatibility mouse events, and iOS Safari drops the `click`
   * when the synthesized `mouseover` changes what is on screen — so opening
   * the menu on a touch "hover" would swallow the tap that starts a chat.
   */
  const pointerType = React.useRef<string | null>(null);
  /** Whether the menu was open when the bookmark was pressed. */
  const openAtPress = React.useRef(false);

  const cancelClose = React.useCallback((): void => {
    if (closeTimer.current !== null) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  // The panel hangs 6px below the button, and that gap belongs to neither — a
  // pointer travelling from one to the other passes through it and would close
  // the menu on the way in. The delay is what makes the trip survivable.
  const scheduleClose = React.useCallback((): void => {
    cancelClose();
    closeTimer.current = setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  }, [cancelClose]);

  React.useEffect(() => cancelClose, [cancelClose]);

  const groups = React.useMemo(() => {
    const commands = {
      items: [
        {
          value: NEW_CONFIG,
          label: 'New configuration…',
          icon: <Plus />,
          action: true,
        },
        ...(configs.length > 0
          ? [
              {
                value: MANAGE_CONFIGS,
                label: 'Manage configurations…',
                icon: <SlidersHorizontal />,
                action: true,
              },
            ]
          : []),
      ],
    };
    if (configs.length === 0) {
      return [commands];
    }
    return [
      {
        label: 'Start from a configuration',
        items: configs.map((config) => ({
          value: config.id,
          label: config.name,
          icon: <Bookmark />,
          // The agent, and the folder under it — the two facts that tell two
          // similarly-named setups apart. Elided from the FRONT, since CSS
          // truncation eats the end that identifies a directory.
          hint: workflowSlugOf(config.target) ?? config.target,
          title: `${config.name} · ${shortenPath(config.cwd)}`,
        })),
      },
      commands,
    ];
  }, [configs]);

  return (
    <span
      className="relative inline-flex"
      onPointerEnter={(event) => {
        pointerType.current = event.pointerType;
      }}
      onPointerDown={(event) => {
        pointerType.current = event.pointerType;
      }}
      onMouseLeave={scheduleClose}>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="hidden size-7 max-sm:inline-flex pointer-coarse:inline-flex"
        aria-label="Saved configurations"
        aria-haspopup="menu"
        aria-expanded={open}
        // The menu closes itself on any outside press, this button included,
        // before the click lands — so the click reads the state the press saw.
        onMouseDown={() => {
          openAtPress.current = open;
        }}
        onClick={() => setOpen(!openAtPress.current)}>
        <Bookmark className="shrink-0" />
      </Button>
      <Button
        ref={triggerRef}
        type="button"
        variant="ghost"
        size="icon"
        data-menu-trigger
        className="size-7"
        // Hover opens from the + itself, so pointing at the bookmark beside it
        // does not open the menu the bookmark is about to toggle.
        onMouseEnter={() => {
          if (pointerType.current !== null && pointerType.current !== 'mouse') {
            return;
          }
          cancelClose();
          setOpen(true);
        }}
        aria-label="New chat"
        aria-haspopup="menu"
        aria-expanded={open}
        title="New chat — hover for saved configurations"
        onClick={() => {
          setOpen(false);
          onNewChat();
        }}
        // The keyboard's way in. Without it the configurations would be
        // pointer-only, since this button's own click is the new thread.
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setOpen(true);
          }
        }}>
        <Plus className="shrink-0" />
      </Button>
      <Menu
        open={open}
        groups={groups}
        side="bottom"
        align="end"
        // The sidebar column scrolls and is narrow, so this panel escapes it
        // the same way a picker inside a dialog does.
        anchor="viewport"
        triggerRef={triggerRef}
        onSelect={(value) => {
          if (value === NEW_CONFIG) {
            onCreate();
            return;
          }
          if (value === MANAGE_CONFIGS) {
            onManage();
            return;
          }
          const chosen = configs.find((config) => config.id === value);
          if (chosen) {
            onApply(chosen);
          }
        }}
        onClose={() => setOpen(false)}
      />
    </span>
  );
}
