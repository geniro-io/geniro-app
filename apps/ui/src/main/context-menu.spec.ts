import { EventEmitter } from 'node:events';

import type { MenuItemConstructorOptions, WebContents } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  templates: [] as MenuItemConstructorOptions[][],
  popup: vi.fn(),
  owner: null as object | null,
}));

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => h.owner },
  clipboard: { writeText: vi.fn() },
  Menu: {
    buildFromTemplate: (template: MenuItemConstructorOptions[]) => {
      h.templates.push(template);
      return { popup: h.popup };
    },
  },
}));

import {
  type ContextMenuInput,
  contextMenuTemplate,
  installContextMenu,
} from './context-menu';

const ALL_FLAGS = {
  canCut: true,
  canCopy: true,
  canPaste: true,
  canSelectAll: true,
};

const ARTIFACT_URL =
  'http://127.0.0.1:47615/v1/artifacts/run-1/art-1/v1?key=abc';

function params(overrides: Partial<ContextMenuInput> = {}): ContextMenuInput {
  return {
    linkURL: '',
    frameURL: 'file:///Applications/Geniro.app/index.html',
    mediaType: 'none',
    hasImageContents: false,
    isEditable: false,
    selectionText: '',
    editFlags: { ...ALL_FLAGS },
    ...overrides,
  };
}

describe('contextMenuTemplate', () => {
  it('offers Copy Image on an image with decoded bytes', () => {
    expect(
      contextMenuTemplate(
        params({ mediaType: 'image', hasImageContents: true }),
      ),
    ).toEqual([{ kind: 'copyImage' }]);
  });

  it('does not offer Copy Image for an image that has not decoded', () => {
    // A still-loading or broken image copies an EMPTY pasteboard, so the entry
    // would silently do nothing — worse than not being there.
    expect(
      contextMenuTemplate(
        params({ mediaType: 'image', hasImageContents: false }),
      ),
    ).toEqual([]);
  });

  it('offers Copy Link on a link, ahead of Copy for a selected one', () => {
    // The reported case: a selected link inside an artifact showed only Copy.
    expect(
      contextMenuTemplate(
        params({
          linkURL: 'https://example.com/docs?tab=1',
          frameURL: ARTIFACT_URL,
          selectionText: 'Documents tab',
        }),
      ),
    ).toEqual([
      { kind: 'copyLink', url: 'https://example.com/docs?tab=1' },
      { kind: 'separator' },
      { kind: 'edit', command: 'copy' },
    ]);
  });

  it('offers Copy Link for a mailto link', () => {
    expect(
      contextMenuTemplate(params({ linkURL: 'mailto:someone@example.com' })),
    ).toEqual([{ kind: 'copyLink', url: 'mailto:someone@example.com' }]);
  });

  it('does not offer Copy Link for a scheme a click would not open', () => {
    expect(
      contextMenuTemplate(params({ linkURL: 'file:///etc/passwd' })),
    ).toEqual([]);
    expect(
      contextMenuTemplate(params({ linkURL: 'javascript:alert(1)' })),
    ).toEqual([]);
    expect(contextMenuTemplate(params({ linkURL: 'not a url' }))).toEqual([]);
  });

  it("does not offer Copy Link for an anchor into the frame's own document", () => {
    // A `#section` link resolves to the artifact route, serving key and all.
    expect(
      contextMenuTemplate(
        params({ linkURL: `${ARTIFACT_URL}#step-3`, frameURL: ARTIFACT_URL }),
      ),
    ).toEqual([]);
  });

  it('offers Copy for a selection in read-only content', () => {
    expect(
      contextMenuTemplate(params({ selectionText: 'some transcript text' })),
    ).toEqual([{ kind: 'edit', command: 'copy' }]);
  });

  it('offers nothing for a right-click on unselected prose', () => {
    // An empty array is the "show no menu" signal — a blank popup is not the
    // fix for a missing one.
    expect(contextMenuTemplate(params())).toEqual([]);
    expect(contextMenuTemplate(params({ selectionText: '   ' }))).toEqual([]);
  });

  it('gives an input the editing set, separated from Select All', () => {
    expect(contextMenuTemplate(params({ isEditable: true }))).toEqual([
      { kind: 'edit', command: 'cut' },
      { kind: 'edit', command: 'copy' },
      { kind: 'edit', command: 'paste' },
      { kind: 'separator' },
      { kind: 'edit', command: 'selectAll' },
    ]);
  });

  it('omits editing entries Chromium says do not apply, and the rule with them', () => {
    // Nothing to cut or copy and an empty pasteboard: only Select All survives,
    // and it must not arrive behind a leading separator.
    expect(
      contextMenuTemplate(
        params({
          isEditable: true,
          editFlags: {
            canCut: false,
            canCopy: false,
            canPaste: false,
            canSelectAll: true,
          },
        }),
      ),
    ).toEqual([{ kind: 'edit', command: 'selectAll' }]);
  });

  it('separates Copy Image from the editing set when both apply', () => {
    expect(
      contextMenuTemplate(
        params({
          mediaType: 'image',
          hasImageContents: true,
          isEditable: true,
          editFlags: { ...ALL_FLAGS, canSelectAll: false },
        }),
      ),
    ).toEqual([
      { kind: 'copyImage' },
      { kind: 'separator' },
      { kind: 'edit', command: 'cut' },
      { kind: 'edit', command: 'copy' },
      { kind: 'edit', command: 'paste' },
    ]);
  });
});

describe('installContextMenu', () => {
  class FakeContents extends EventEmitter {
    cut = vi.fn();
    copy = vi.fn();
    paste = vi.fn();
    selectAll = vi.fn();
    copyImageAt = vi.fn();
  }

  const rightClickOnField = {
    x: 40,
    y: 25,
    linkURL: '',
    pageURL: 'https://stand.test/',
    frame: { url: 'https://stand.test/' },
    mediaType: 'none',
    hasImageContents: false,
    isEditable: true,
    selectionText: '',
    editFlags: { ...ALL_FLAGS },
  };

  const install = (
    ...placement: [] | [Parameters<typeof installContextMenu>[1]]
  ): FakeContents => {
    const contents = new FakeContents();
    installContextMenu(contents as unknown as WebContents, ...placement);
    return contents;
  };

  const clickItem = (label: string): void => {
    const item = h.templates.at(-1)?.find((entry) => entry.label === label);
    expect(item, label).toBeDefined();
    (item?.click as (() => void) | undefined)?.();
  };

  beforeEach(() => {
    h.templates.length = 0;
    h.popup.mockReset();
    h.owner = { id: 'main-window' };
  });

  it('pops over the window the contents fills, at the click', () => {
    const contents = install();

    contents.emit('context-menu', {}, rightClickOnField);

    expect(h.popup).toHaveBeenCalledWith({ window: h.owner, x: 40, y: 25 });
  });

  it('runs the editing entries on the contents that raised the menu, not as roles', () => {
    const contents = install();

    contents.emit('context-menu', {}, rightClickOnField);
    const template = h.templates.at(-1) ?? [];
    clickItem('Paste');
    clickItem('Cut');
    clickItem('Copy');
    clickItem('Select All');

    expect(template.some((item) => item.role !== undefined)).toBe(false);
    expect(contents.paste).toHaveBeenCalledTimes(1);
    expect(contents.cut).toHaveBeenCalledTimes(1);
    expect(contents.copy).toHaveBeenCalledTimes(1);
    expect(contents.selectAll).toHaveBeenCalledTimes(1);
  });

  it('offsets the menu by where a view sits inside its window', () => {
    const host = { id: 'pop-out' };
    const contents = install(() => ({
      window: host as never,
      x: 300,
      y: 92,
    }));

    contents.emit('context-menu', {}, rightClickOnField);

    expect(h.popup).toHaveBeenCalledWith({ window: host, x: 340, y: 117 });
  });

  it('shows no menu for a view that is not on screen', () => {
    const contents = install(() => null);

    contents.emit('context-menu', {}, rightClickOnField);

    expect(h.popup).not.toHaveBeenCalled();
  });

  it('copies an image at the coordinates the contents reported, not the offset ones', () => {
    const contents = install(() => ({
      window: { id: 'main-window' } as never,
      x: 300,
      y: 92,
    }));

    contents.emit(
      'context-menu',
      {},
      {
        ...rightClickOnField,
        isEditable: false,
        mediaType: 'image',
        hasImageContents: true,
      },
    );
    clickItem('Copy Image');

    expect(contents.copyImageAt).toHaveBeenCalledWith(40, 25);
  });
});
