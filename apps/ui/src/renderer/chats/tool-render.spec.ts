import { describe, expect, it } from 'vitest';

import { stripLineNumbers, toolInputBody, toolResultBody } from './tool-render';

describe('toolInputBody', () => {
  it('renders a shell call as its command, highlighted as shell', () => {
    // The screenshot bug: this used to print the whole {"command":…,
    // "description":…} envelope as raw JSON.
    expect(
      toolInputBody('Bash', {
        command: 'git show origin/develop:a.tf | head -160',
        description: 'Read the terraform',
      }),
    ).toEqual({
      kind: 'code',
      code: 'git show origin/develop:a.tf | head -160',
      language: 'bash',
      caption: 'Read the terraform',
    });
  });

  it('renders an edit as a diff, reusing the existing DiffView contract', () => {
    const body = toolInputBody('Edit', {
      file_path: '/proj/a.ts',
      old_string: 'const a = 1;',
      new_string: 'const a = 2;',
    });
    expect(body).toEqual({
      kind: 'diff',
      oldText: 'const a = 1;',
      newText: 'const a = 2;',
      caption: '/proj/a.ts',
    });
  });

  it('renders a write as an all-additions diff, not a wall of JSON', () => {
    // editDiffOf already treats Write as "no old text, all new" — a new file
    // reads best as green additions, and reusing that beats a second path.
    expect(
      toolInputBody('Write', {
        file_path: '/proj/thing.py',
        content: 'x = 1\n',
      }),
    ).toEqual({
      kind: 'diff',
      oldText: null,
      newText: 'x = 1\n',
      caption: '/proj/thing.py',
    });
  });

  it('dispatches on SHAPE, so a differently-named shell tool still works', () => {
    // cursor-agent names its tools differently; keying on the name alone would
    // silently drop every one of them back to raw JSON.
    expect(
      toolInputBody('run_terminal_cmd', { command: 'ls -la' }),
    ).toMatchObject({ kind: 'code', code: 'ls -la', language: 'bash' });
  });

  it('falls back to highlighted JSON for a tool it does not recognize', () => {
    const body = toolInputBody('SomeFutureTool', { alpha: 1, beta: [2] });
    expect(body).toMatchObject({ kind: 'code', language: 'json' });
    expect(body?.kind === 'code' && body.code).toContain('"alpha": 1');
  });

  it('captions a path-only call with the path it targets', () => {
    expect(toolInputBody('Read', { file_path: '/proj/a.ts' })).toMatchObject({
      kind: 'code',
      caption: '/proj/a.ts',
    });
  });

  it('survives a payload JSON cannot stringify', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => toolInputBody('X', cyclic)).not.toThrow();
  });

  it('renders NO body for a call that disclosed no arguments', () => {
    // The reported defect: cursor names a read/search/edit call and sends an
    // EMPTY argument bag, which this function used to render as the literal
    // `{}` — stating the arguments were empty rather than absent. The row's
    // header already carries the tool name, which is the part that is known.
    expect(toolInputBody('Read File', {})).toBeNull();
  });

  it('renders NO body when there are no arguments at all', () => {
    // The daemon normalizes an empty bag to null before it ever reaches here
    // (`disclosedInput` in acp-driver.ts), so null is the shape this actually
    // receives in production — and `prettyJson` would have printed `null`.
    expect(toolInputBody('Read File', null)).toBeNull();
    expect(toolInputBody('Read File', undefined)).toBeNull();
  });
});

describe('toolResultBody', () => {
  it('highlights a file read in the language of the file that was read', () => {
    // The result is bare text — only the CALL's input can say what it is.
    expect(
      toolResultBody(
        { file_path: '/proj/a.py' },
        '     1\tx = 1\n     2\ty = 2',
      ),
    ).toEqual({
      kind: 'code',
      code: 'x = 1\ny = 2',
      language: 'python',
      caption: null,
    });
  });

  it('leaves command OUTPUT unhighlighted', () => {
    // Painting arbitrary stdout as shell would colour ordinary words as
    // keywords, which reads as noise rather than structure.
    expect(toolResultBody({ command: 'ls' }, 'a.ts\nb.ts')).toMatchObject({
      language: null,
    });
  });

  it('highlights a structured result as JSON', () => {
    expect(toolResultBody(null, { ok: true })).toMatchObject({
      language: 'json',
    });
  });
});

describe('stripLineNumbers', () => {
  it('drops a cat -n gutter so the body highlights as its language', () => {
    expect(stripLineNumbers('     1\tconst a = 1;\n     2\tconst b = 2;')).toBe(
      'const a = 1;\nconst b = 2;',
    );
  });

  it('leaves text alone unless EVERY line carries a gutter', () => {
    // A file whose first line merely starts with a number must not be shaved.
    expect(stripLineNumbers('     1\tconst a = 1;\nplain line')).toBe(
      '     1\tconst a = 1;\nplain line',
    );
  });
});
