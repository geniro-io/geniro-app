import {
  Menu,
  type MenuItemConstructorOptions,
  type WebContents,
} from 'electron';

/**
 * The right-click menu, which Electron does NOT provide for you.
 *
 * A packaged Electron app has no context menu at all unless it builds one: the
 * renderer is Chromium, but the menu Chrome shows is the BROWSER's, and an
 * Electron host ships none in its place. So every right-click in this app did
 * nothing, anywhere — REPORTED against an image opened from a chat: "оно
 * открывается, но я не могу нажать на него правой кнопкой мыши, например,
 * чтобы копировать его. То есть оно не воспринимается как изображение." The
 * image was a perfectly ordinary `<img>`; what was missing was the menu.
 *
 * Copying the IMAGE is the one entry that cannot be a role. Chromium's editing
 * roles (`cut`/`copy`/`paste`/`selectAll`) act on the selection and would copy
 * the image's markup or nothing at all, so it goes through
 * `WebContents.copyImageAt`, which puts the decoded BITMAP on the pasteboard —
 * the thing a Mac user gets from Finder or Preview, pasteable into any app.
 * The coordinates are the ones the event reported, and they must be: it copies
 * whatever image is at that point, not "the image this menu is about".
 *
 * Everything else IS a role, deliberately. A role is wired to Chromium's own
 * editing commands and picks up the platform's labels and accelerators for
 * free, so the menu reads as the system's rather than as a translation of it.
 */

/** The subset of Electron's `ContextMenuParams` the template actually reads. */
export interface ContextMenuInput {
  /** `'image'` when the click landed on one; `'none'` for ordinary content. */
  mediaType: string;
  /**
   * Whether that image has DECODED bytes to copy. False for one that is still
   * loading or failed — offering Copy Image there yields an empty pasteboard,
   * which is worse than not offering it.
   */
  hasImageContents: boolean;
  /** Whether the click landed in a text input or a contenteditable. */
  isEditable: boolean;
  /** The selected text, if any. */
  selectionText: string;
  /** Chromium's own verdict on which editing commands apply right now. */
  editFlags: {
    canCut: boolean;
    canCopy: boolean;
    canPaste: boolean;
    canSelectAll: boolean;
  };
}

/** One entry, named rather than built — see {@link contextMenuTemplate}. */
export type ContextMenuEntry =
  | { kind: 'role'; role: 'cut' | 'copy' | 'paste' | 'selectAll' }
  | { kind: 'copyImage' }
  | { kind: 'separator' };

/**
 * What the menu should hold for one right-click, as named entries.
 *
 * Pure, and returning descriptors rather than Electron menu items, so the
 * decisions here can be driven in a spec — `Menu`/`MenuItem` cannot be
 * constructed outside a running Electron app, which would otherwise leave the
 * only interesting part of this file untestable.
 *
 * An empty array means NO MENU, not an empty one: a right-click on plain
 * unselected prose has nothing to offer, and popping up a blank rectangle
 * there is a worse answer than the nothing this replaces.
 */
export function contextMenuTemplate(
  params: ContextMenuInput,
): ContextMenuEntry[] {
  const groups: ContextMenuEntry[][] = [];

  if (params.mediaType === 'image' && params.hasImageContents) {
    groups.push([{ kind: 'copyImage' }]);
  }

  if (params.isEditable) {
    // An input gets the full editing set, each entry gated on Chromium's own
    // flag — a `paste` offered with an empty pasteboard is a dead row, and the
    // renderer is the only thing that can know.
    const editing: ContextMenuEntry[] = [];
    if (params.editFlags.canCut) {
      editing.push({ kind: 'role', role: 'cut' });
    }
    if (params.editFlags.canCopy) {
      editing.push({ kind: 'role', role: 'copy' });
    }
    if (params.editFlags.canPaste) {
      editing.push({ kind: 'role', role: 'paste' });
    }
    if (editing.length > 0) {
      groups.push(editing);
    }
    if (params.editFlags.canSelectAll) {
      groups.push([{ kind: 'role', role: 'selectAll' }]);
    }
  } else if (params.selectionText.trim() !== '' && params.editFlags.canCopy) {
    // Read-only content with a selection: copying it is the only thing that
    // makes sense, and it is the other half of what gets asked for here.
    groups.push([{ kind: 'role', role: 'copy' }]);
  }

  // Separators BETWEEN groups only. Built by joining rather than by pushing and
  // trimming, so a leading or trailing rule cannot appear when a group turns
  // out to be empty.
  return groups.flatMap((group, index) =>
    index === 0 ? group : [{ kind: 'separator' as const }, ...group],
  );
}

/**
 * Give one WebContents the menu above.
 *
 * Installed per WebContents rather than once on `app`, because the entries act
 * on the contents that raised the event — `copyImageAt` is a method on it.
 */
export function installContextMenu(contents: WebContents): void {
  contents.on('context-menu', (_event, params) => {
    const entries = contextMenuTemplate({
      mediaType: params.mediaType,
      hasImageContents: params.hasImageContents,
      isEditable: params.isEditable,
      selectionText: params.selectionText,
      editFlags: {
        canCut: params.editFlags.canCut,
        canCopy: params.editFlags.canCopy,
        canPaste: params.editFlags.canPaste,
        canSelectAll: params.editFlags.canSelectAll,
      },
    });
    if (entries.length === 0) {
      return;
    }
    const template: MenuItemConstructorOptions[] = entries.map((entry) => {
      if (entry.kind === 'separator') {
        return { type: 'separator' };
      }
      if (entry.kind === 'copyImage') {
        return {
          label: 'Copy Image',
          click: () => contents.copyImageAt(params.x, params.y),
        };
      }
      return { role: entry.role };
    });
    Menu.buildFromTemplate(template).popup({});
  });
}
