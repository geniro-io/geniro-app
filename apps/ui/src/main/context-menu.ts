import {
  BrowserWindow,
  clipboard,
  Menu,
  type MenuItemConstructorOptions,
  type WebContents,
} from 'electron';

import { EXTERNAL_LINK_SCHEMES } from '../shared/link-schemes';

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
 * Copying a LINK is the other one. A right-click on an anchor — in the
 * transcript or inside an artifact's frame, whose events reach this same
 * WebContents — copies nothing but the selection without it, while every
 * browser offers its address. REPORTED: "I want to be able to copy links in
 * artifact by clicking to them with right click … as in normal browser". The
 * address is Chromium's `linkURL`, already resolved against the frame's
 * document, and it goes on the pasteboard as plain text.
 *
 * Everything else IS a role, deliberately. A role is wired to Chromium's own
 * editing commands and picks up the platform's labels and accelerators for
 * free, so the menu reads as the system's rather than as a translation of it.
 */

/** The subset of Electron's `ContextMenuParams` the template actually reads. */
export interface ContextMenuInput {
  /** The resolved address of the link under the click; empty when there is none. */
  linkURL: string;
  /**
   * The address of the document that link sits in — the artifact frame's own
   * for a click inside one. A link back into that same document (a `#section`
   * anchor) is not offered: its address is the artifact route, which carries
   * the page's serving key and is no use outside this app.
   */
  frameURL: string;
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
  | { kind: 'copyLink'; url: string }
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

  const link = copyableLink(params.linkURL, params.frameURL);
  if (link !== null) {
    groups.push([{ kind: 'copyLink', url: link }]);
  }

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
 * The link address worth copying, or null.
 *
 * Only the schemes a click would open ({@link EXTERNAL_LINK_SCHEMES}): the
 * renderer's own `file:` routes and the like are app plumbing, not addresses
 * anyone can use elsewhere. A link to the very document it sits in, fragment
 * aside, is dropped for the reason {@link ContextMenuInput.frameURL} gives.
 */
function copyableLink(linkURL: string, frameURL: string): string | null {
  let link: URL;
  try {
    link = new URL(linkURL);
  } catch {
    return null;
  }
  if (!EXTERNAL_LINK_SCHEMES.has(link.protocol)) {
    return null;
  }
  if (withoutHash(link.href) === withoutHash(frameURL)) {
    return null;
  }
  return linkURL;
}

function withoutHash(url: string): string {
  const hash = url.indexOf('#');
  return hash === -1 ? url : url.slice(0, hash);
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
      linkURL: params.linkURL,
      // The frame the click landed in, which for an artifact is its own
      // document rather than the renderer's.
      frameURL: params.frame?.url ?? params.pageURL,
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
      if (entry.kind === 'copyLink') {
        return {
          label: 'Copy Link',
          click: () => clipboard.writeText(entry.url),
        };
      }
      if (entry.kind === 'copyImage') {
        return {
          label: 'Copy Image',
          click: () => contents.copyImageAt(params.x, params.y),
        };
      }
      return { role: entry.role };
    });
    // Popped at the CLICK, not at the pointer. With a mouse the two are the
    // same point, so this changes nothing a user can see there — it matters
    // for the ways a context menu is raised WITHOUT a pointer (the keyboard's
    // menu key, an accessibility client), where Electron's default of "wherever
    // the cursor happens to be" draws the menu somewhere the request never
    // named. It also matches what the menu ACTS on: `copyImageAt` is given
    // these same coordinates.
    Menu.buildFromTemplate(template).popup({
      window: BrowserWindow.fromWebContents(contents) ?? undefined,
      x: params.x,
      y: params.y,
    });
  });
}
