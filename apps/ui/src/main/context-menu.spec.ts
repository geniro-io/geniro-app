import { describe, expect, it } from 'vitest';

import { type ContextMenuInput, contextMenuTemplate } from './context-menu';

/**
 * The template only — `Menu`/`MenuItem` cannot be constructed outside a running
 * Electron app, which is exactly why the decisions live in a pure function.
 */

const ALL_FLAGS = {
  canCut: true,
  canCopy: true,
  canPaste: true,
  canSelectAll: true,
};

function params(overrides: Partial<ContextMenuInput> = {}): ContextMenuInput {
  return {
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

  it('offers Copy for a selection in read-only content', () => {
    expect(
      contextMenuTemplate(params({ selectionText: 'some transcript text' })),
    ).toEqual([{ kind: 'role', role: 'copy' }]);
  });

  it('offers nothing for a right-click on unselected prose', () => {
    // An empty array is the "show no menu" signal — a blank popup is not the
    // fix for a missing one.
    expect(contextMenuTemplate(params())).toEqual([]);
    expect(contextMenuTemplate(params({ selectionText: '   ' }))).toEqual([]);
  });

  it('gives an input the editing set, separated from Select All', () => {
    expect(contextMenuTemplate(params({ isEditable: true }))).toEqual([
      { kind: 'role', role: 'cut' },
      { kind: 'role', role: 'copy' },
      { kind: 'role', role: 'paste' },
      { kind: 'separator' },
      { kind: 'role', role: 'selectAll' },
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
    ).toEqual([{ kind: 'role', role: 'selectAll' }]);
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
      { kind: 'role', role: 'cut' },
      { kind: 'role', role: 'copy' },
      { kind: 'role', role: 'paste' },
    ]);
  });
});
