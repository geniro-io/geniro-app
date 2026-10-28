import { describe, expect, it, vi } from 'vitest';

import {
  MAX_BUFFERED_LINE_CHARS,
  NdjsonBuffer,
  OVERSIZED_LINE_PREFIX_CHARS,
} from './ndjson-buffer';

describe('NdjsonBuffer', () => {
  it('parses multiple complete lines from a single chunk', () => {
    const objs: unknown[] = [];
    const buf = new NdjsonBuffer({ onObject: (o) => objs.push(o) });

    buf.push('{"type":"a"}\n{"type":"b"}\n');

    expect(objs).toEqual([{ type: 'a' }, { type: 'b' }]);
  });

  it('reassembles a JSON object split across two chunks', () => {
    const objs: unknown[] = [];
    const buf = new NdjsonBuffer({ onObject: (o) => objs.push(o) });

    buf.push('{"type":"assist');
    expect(objs).toEqual([]); // no newline yet — nothing emitted
    buf.push('ant","text":"hi"}\n');

    expect(objs).toEqual([{ type: 'assistant', text: 'hi' }]);
  });

  it('emits one object per line when several arrive over many chunks', () => {
    const objs: unknown[] = [];
    const buf = new NdjsonBuffer({ onObject: (o) => objs.push(o) });

    buf.push('{"n":1}\n{"n":2}');
    buf.push('\n{"n":3}\n');

    expect(objs).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  it('skips blank and whitespace-only lines', () => {
    const objs: unknown[] = [];
    const buf = new NdjsonBuffer({ onObject: (o) => objs.push(o) });

    buf.push('\n   \n{"n":1}\n\n');

    expect(objs).toEqual([{ n: 1 }]);
  });

  it('tolerates CRLF line endings', () => {
    const objs: unknown[] = [];
    const buf = new NdjsonBuffer({ onObject: (o) => objs.push(o) });

    buf.push('{"n":1}\r\n{"n":2}\r\n');

    expect(objs).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('reports a malformed line and keeps processing the rest', () => {
    const objs: unknown[] = [];
    const onParseError = vi.fn();
    const buf = new NdjsonBuffer({
      onObject: (o) => objs.push(o),
      onParseError,
    });

    buf.push('{"ok":1}\nnot json at all\n{"ok":2}\n');

    expect(objs).toEqual([{ ok: 1 }, { ok: 2 }]);
    expect(onParseError).toHaveBeenCalledTimes(1);
    expect(onParseError.mock.calls[0]?.[0]).toBe('not json at all');
  });

  it('never throws on a malformed line when no onParseError is given', () => {
    const objs: unknown[] = [];
    const buf = new NdjsonBuffer({ onObject: (o) => objs.push(o) });

    expect(() => buf.push('garbage\n{"ok":1}\n')).not.toThrow();
    expect(objs).toEqual([{ ok: 1 }]);
  });

  it('flush() emits a trailing line that has no terminating newline', () => {
    const objs: unknown[] = [];
    const buf = new NdjsonBuffer({ onObject: (o) => objs.push(o) });

    buf.push('{"type":"result"}'); // CLI ended without a final newline
    expect(objs).toEqual([]);
    buf.flush();

    expect(objs).toEqual([{ type: 'result' }]);
  });

  it('flush() is a no-op when the buffer is empty', () => {
    const objs: unknown[] = [];
    const buf = new NdjsonBuffer({ onObject: (o) => objs.push(o) });

    buf.push('{"n":1}\n');
    buf.flush();
    buf.flush();

    expect(objs).toEqual([{ n: 1 }]);
  });

  it('passes through unknown-but-valid JSON shapes for the mapper to triage', () => {
    const objs: unknown[] = [];
    const buf = new NdjsonBuffer({ onObject: (o) => objs.push(o) });

    buf.push('{"type":"rate_limit_event","tier":"x"}\n');

    expect(objs).toEqual([{ type: 'rate_limit_event', tier: 'x' }]);
  });
});

describe('NdjsonBuffer bounded reassembly buffer', () => {
  it('skips an over-cap line to its newline, reports it once with its length, and parses the next line', () => {
    const objs: unknown[] = [];
    const onParseError = vi.fn();
    const onOversizedLine = vi.fn();
    const buf = new NdjsonBuffer({
      onObject: (o) => objs.push(o),
      onParseError,
      onOversizedLine,
    });

    buf.push('{"id":2,"result":"');
    buf.push('x'.repeat(MAX_BUFFERED_LINE_CHARS));
    buf.push('y'.repeat(1000));
    expect(onOversizedLine).not.toHaveBeenCalled();

    buf.push('"}\n{"a":1}\n');
    const length =
      '{"id":2,"result":"'.length + MAX_BUFFERED_LINE_CHARS + 1000 + 2;
    expect(onOversizedLine).toHaveBeenCalledTimes(1);
    expect(onOversizedLine).toHaveBeenCalledWith(
      ('{"id":2,"result":"' + 'x'.repeat(MAX_BUFFERED_LINE_CHARS)).slice(
        0,
        OVERSIZED_LINE_PREFIX_CHARS,
      ),
      length,
    );
    expect(onParseError).not.toHaveBeenCalled();
    expect(objs).toEqual([{ a: 1 }]);
  });

  it('keeps an exactly-at-cap line buffered rather than dropping it', () => {
    const objs: unknown[] = [];
    const onOversizedLine = vi.fn();
    const buf = new NdjsonBuffer({
      onObject: (o) => objs.push(o),
      onOversizedLine,
    });
    const body = 'x'.repeat(MAX_BUFFERED_LINE_CHARS - '{"b":""}'.length);
    buf.push(`{"b":"${body}`);
    buf.push('"}');
    buf.push('\n');
    expect(onOversizedLine).not.toHaveBeenCalled();
    expect(objs).toEqual([{ b: body }]);
  });

  it('reports an over-cap line the stream ended inside at flush', () => {
    const onOversizedLine = vi.fn();
    const buf = new NdjsonBuffer({ onObject: vi.fn(), onOversizedLine });
    buf.push('z'.repeat(MAX_BUFFERED_LINE_CHARS + 1));
    buf.push('z'.repeat(9));
    buf.flush();
    expect(onOversizedLine).toHaveBeenCalledTimes(1);
    expect(onOversizedLine).toHaveBeenCalledWith(
      'z'.repeat(OVERSIZED_LINE_PREFIX_CHARS),
      MAX_BUFFERED_LINE_CHARS + 10,
    );
  });

  it('never falsely drops a large-but-under-cap line once its newline arrives', () => {
    const objs: unknown[] = [];
    const onParseError = vi.fn();
    const buf = new NdjsonBuffer({
      onObject: (o) => objs.push(o),
      onParseError,
    });

    const big = 'y'.repeat(2 * 1024 * 1024); // multi-MB but under the cap
    buf.push('{"big":"');
    buf.push(big);
    buf.push('"}\n');

    expect(onParseError).not.toHaveBeenCalled();
    expect(objs).toEqual([{ big }]);
  });
});
