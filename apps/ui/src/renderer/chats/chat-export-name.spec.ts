import { describe, expect, it } from 'vitest';

import { chatExportSaveSchema } from '../../main/ipc-schemas';
import { chatExportFileName } from './chat-export-name';

describe('chatExportFileName', () => {
  it('keeps the thread recognisable in the file name', () => {
    expect(chatExportFileName('Auth deep-dive')).toBe(
      'Auth-deep-dive-export.json',
    );
  });

  it('strips what a PATH would act on, so main never has to refuse it', () => {
    // The whole point of the helper: a title is whatever the user typed, and
    // `showSaveDialog`'s defaultPath reads a separator as a directory.
    const name = chatExportFileName('fix apps/ui: the ../ bug?');
    expect(name).not.toMatch(/[/\\]/);
    // Round-tripped through the schema that guards the channel — the real
    // gate, not a re-statement of the rule here.
    expect(() =>
      chatExportSaveSchema.parse({ suggestedName: name, content: '{}' }),
    ).not.toThrow();
  });

  it('never produces a hidden file or a bare dot name', () => {
    // A leading dot hides the file in Finder, and `.`/`..` name a directory —
    // the branch that makes the fallback below reachable at all.
    expect(chatExportFileName('...')).toBe('chat-export.json');
    expect(chatExportFileName('.hidden thread')).toBe(
      'hidden-thread-export.json',
    );
  });

  it('falls back rather than failing on a label with nothing usable in it', () => {
    // A thread called `///` is still worth exporting; the name is only ever a
    // suggestion the user can change in the dialog.
    expect(chatExportFileName('///')).toBe('chat-export.json');
    expect(chatExportFileName('   ')).toBe('chat-export.json');
  });

  it('bounds a generated title well inside the 255-byte name limit', () => {
    // Chat titles are generated from an opening line and run long.
    const name = chatExportFileName('word '.repeat(200));
    expect(name.length).toBeLessThanOrEqual(255);
    expect(() =>
      chatExportSaveSchema.parse({ suggestedName: name, content: '{}' }),
    ).not.toThrow();
  });
});

describe('chatExportSaveSchema', () => {
  it('refuses a name carrying a path separator', () => {
    // The bug-catcher behind the helper: if the shaping above is ever bypassed,
    // the channel still will not open a dialog somewhere the user did not ask.
    expect(() =>
      chatExportSaveSchema.parse({
        suggestedName: '../../etc/passwd',
        content: '{}',
      }),
    ).toThrow();
  });

  it('refuses a name carrying a control character', () => {
    expect(() =>
      chatExportSaveSchema.parse({
        // Written as the ESCAPE, never as the raw byte: a NUL in the
        // first 8000 bytes makes git classify the file as binary and
        // the pre-commit hook refuses it, while the two are the
        // identical code unit at runtime.
        suggestedName: 'thread\u0000.json',
        content: '{}',
      }),
    ).toThrow();
  });

  it('accepts a LARGE document — the long conversations are the point', () => {
    // `content` is deliberately not length-bounded; a cap would refuse exactly
    // the transcripts this feature exists for.
    expect(() =>
      chatExportSaveSchema.parse({
        suggestedName: 'big-export.json',
        content: 'x'.repeat(20_000_000),
      }),
    ).not.toThrow();
  });
});
