import { describe, expect, it } from 'vitest';

import { chatExportSaveSchema } from '../../main/ipc-schemas';
import { chatExportBaseName } from './chat-export-name';

/** A payload the schema accepts apart from whichever field a case is testing. */
const save = (over: Record<string, unknown>): Record<string, unknown> => ({
  suggestedName: 'chat-export',
  json: '{}',
  markdown: '# chat',
  ...over,
});

describe('chatExportBaseName', () => {
  it('keeps the thread recognisable in the file name', () => {
    expect(chatExportBaseName('Auth deep-dive')).toBe('Auth-deep-dive-export');
  });

  it('carries NO extension — the format is main’s to decide', () => {
    // Main orders the save panel's filters, so it is what knows which format is
    // the default; an extension chosen here as well would be a second answer,
    // and the one that lost would show a name the panel then silently changed.
    expect(chatExportBaseName('Auth deep-dive')).not.toContain('.');
  });

  it('strips what a PATH would act on, so main never has to refuse it', () => {
    // The whole point of the helper: a title is whatever the user typed, and
    // `showSaveDialog`'s defaultPath reads a separator as a directory.
    const name = chatExportBaseName('fix apps/ui: the ../ bug?');
    expect(name).not.toMatch(/[/\\]/);
    // Round-tripped through the schema that guards the channel — the real
    // gate, not a re-statement of the rule here.
    expect(() =>
      chatExportSaveSchema.parse(save({ suggestedName: name })),
    ).not.toThrow();
  });

  it('never produces a hidden file or a bare dot name', () => {
    // A leading dot hides the file in Finder, and `.`/`..` name a directory —
    // the branch that makes the fallback below reachable at all.
    expect(chatExportBaseName('...')).toBe('chat-export');
    expect(chatExportBaseName('.hidden thread')).toBe('hidden-thread-export');
  });

  it('falls back rather than failing on a label with nothing usable in it', () => {
    // A thread called `///` is still worth exporting; the name is only ever a
    // suggestion the user can change in the dialog.
    expect(chatExportBaseName('///')).toBe('chat-export');
    expect(chatExportBaseName('   ')).toBe('chat-export');
  });

  it('bounds a generated title well inside the 255-byte name limit', () => {
    // Chat titles are generated from an opening line and run long.
    const name = chatExportBaseName('word '.repeat(200));
    expect(name.length).toBeLessThanOrEqual(255);
    expect(() =>
      chatExportSaveSchema.parse(save({ suggestedName: name })),
    ).not.toThrow();
  });
});

describe('chatExportSaveSchema', () => {
  it('refuses a name carrying a path separator', () => {
    // The bug-catcher behind the helper: if the shaping above is ever bypassed,
    // the channel still will not open a dialog somewhere the user did not ask.
    expect(() =>
      chatExportSaveSchema.parse(save({ suggestedName: '../../etc/passwd' })),
    ).toThrow();
  });

  it('refuses a TAB or NEWLINE, which the prose screen beside it allows', () => {
    // The bar for a file name is not the bar for a settings box. The shared
    // `hasControlCharacters` whitelists tab/LF/CR because prose legitimately
    // carries them; a name reaching `showSaveDialog`'s `defaultPath` may carry
    // neither, and this schema's own doc promises it refuses them.
    expect(() =>
      chatExportSaveSchema.parse(save({ suggestedName: 'report\tv2' })),
    ).toThrow();
    expect(() =>
      chatExportSaveSchema.parse(save({ suggestedName: 'report\nv2' })),
    ).toThrow();
  });

  it('refuses a name carrying a control character', () => {
    expect(() =>
      chatExportSaveSchema.parse(
        // Written as the ESCAPE, never as the raw byte: a NUL in the
        // first 8000 bytes makes git classify the file as binary and
        // the pre-commit hook refuses it, while the two are the
        // identical code unit at runtime.
        save({ suggestedName: 'thread\u0000-export' }),
      ),
    ).toThrow();
  });

  it('requires BOTH renderings, since either may be the one written', () => {
    // The format is chosen in the save panel, which only main can read — so a
    // payload carrying one document would leave main with nothing to write for
    // half the choices it offers.
    const { markdown: _markdown, ...withoutMarkdown } = save({});
    expect(() => chatExportSaveSchema.parse(withoutMarkdown)).toThrow();
    const { json: _json, ...withoutJson } = save({});
    expect(() => chatExportSaveSchema.parse(withoutJson)).toThrow();
  });

  it('accepts a LARGE document — the long conversations are the point', () => {
    // Neither document is length-bounded; a cap would refuse exactly the
    // transcripts this feature exists for.
    expect(() =>
      chatExportSaveSchema.parse(
        save({
          json: 'x'.repeat(20_000_000),
          markdown: 'y'.repeat(20_000_000),
        }),
      ),
    ).not.toThrow();
  });
});
