// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  appendPaths,
  CHAT_UPLOAD_MAX_BYTES,
  type FileAttachTarget,
  useFileAttach,
} from './use-file-attach';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

describe('appendPaths', () => {
  it('puts each path on its own line after the text', () => {
    expect(appendPaths('look at these', ['/a b/x.pdf', '/c.zip'])).toBe(
      'look at these\n/a b/x.pdf\n/c.zip',
    );
  });

  it('adds no separator to an empty box or one already ending in whitespace', () => {
    expect(appendPaths('', ['/x'])).toBe('/x');
    expect(appendPaths('see:\n', ['/x'])).toBe('see:\n/x');
  });

  it('leaves the text alone when nothing was attached', () => {
    expect(appendPaths('hi', [])).toBe('hi');
  });
});

const file = (name: string, type: string, size = 4): File => {
  const blob = new File(['x'.repeat(Math.min(size, 16))], name, { type });
  // jsdom sizes a File from its parts; an oversize one is stated rather than
  // allocated.
  Object.defineProperty(blob, 'size', { value: size });
  return blob;
};

interface Harness {
  attach: (files: File[]) => void;
  uploading: () => boolean;
  error: () => string | null;
}

function mount(target: FileAttachTarget): Harness {
  let latest: ReturnType<typeof useFileAttach> | null = null;
  function Probe(): null {
    latest = useFileAttach(target);
    return null;
  }
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<Probe />);
  });
  return {
    attach: (files) => {
      act(() => {
        latest!.attach(files);
      });
    },
    uploading: () => latest!.uploading,
    error: () => latest!.error,
  };
}

/** A target whose every seam records, on the Mac unless `remote` says not. */
function targetOf(
  overrides: Partial<FileAttachTarget> = {},
): FileAttachTarget & {
  delivered: { owner: string; paths: readonly string[] }[];
  staged: File[];
} {
  const delivered: { owner: string; paths: readonly string[] }[] = [];
  const staged: File[] = [];
  return {
    delivered,
    staged,
    remote: false,
    // Stages PNGs, hands back the rest — the shape `addFiles` answers in.
    stageImages: (files) => {
      staged.push(...files.filter((f) => f.type === 'image/png'));
      return files.filter((f) => f.type !== 'image/png');
    },
    resolvePath: (f) => `/Users/me/${f.name}`,
    upload: () => Promise.reject(new Error('not on the Mac')),
    currentOwner: () => 'run-1',
    deliver: (owner, paths) => delivered.push({ owner, paths }),
    ...overrides,
  };
}

describe('useFileAttach', () => {
  it('stages an image and writes every other file’s path on the Mac', () => {
    const target = targetOf();
    const harness = mount(target);

    harness.attach([
      file('shot.png', 'image/png'),
      file('spec.pdf', 'application/pdf'),
      file('bundle.zip', 'application/zip'),
    ]);

    expect(target.staged.map((f) => f.name)).toEqual(['shot.png']);
    expect(target.delivered).toEqual([
      {
        owner: 'run-1',
        paths: ['/Users/me/spec.pdf', '/Users/me/bundle.zip'],
      },
    ]);
  });

  it('delivers nothing when every pick was an image', () => {
    const target = targetOf();
    mount(target).attach([file('shot.png', 'image/png')]);

    expect(target.delivered).toEqual([]);
  });

  it('uploads on a phone and writes the stored copy’s path', async () => {
    const upload = vi.fn((f: File) =>
      Promise.resolve(`/Mac/chat-uploads/u/${f.name}`),
    );
    const target = targetOf({ remote: true, upload });
    const harness = mount(target);

    harness.attach([file('notes.txt', 'text/plain')]);
    expect(harness.uploading()).toBe(true);
    await act(async () => {
      await Promise.resolve();
    });

    expect(upload).toHaveBeenCalledTimes(1);
    expect(target.delivered).toEqual([
      { owner: 'run-1', paths: ['/Mac/chat-uploads/u/notes.txt'] },
    ]);
    expect(harness.uploading()).toBe(false);
  });

  it('delivers to the draft the file was picked FOR, after a thread switch', async () => {
    let owner = 'run-1';
    let finish: (path: string) => void = () => {};
    const target = targetOf({
      remote: true,
      currentOwner: () => owner,
      upload: () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    });
    const harness = mount(target);

    harness.attach([file('a.txt', 'text/plain')]);
    owner = 'run-2';
    await act(async () => {
      finish('/Mac/a.txt');
      await Promise.resolve();
    });

    expect(target.delivered).toEqual([
      { owner: 'run-1', paths: ['/Mac/a.txt'] },
    ]);
  });

  it('refuses an oversize file on a phone before sending its bytes', () => {
    const upload = vi.fn(() => Promise.resolve('/x'));
    const target = targetOf({ remote: true, upload });
    const harness = mount(target);

    harness.attach([
      file('huge.mov', 'video/quicktime', CHAT_UPLOAD_MAX_BYTES + 1),
    ]);

    expect(upload).not.toHaveBeenCalled();
    expect(harness.error()).toMatch(/huge\.mov is larger than 25MB/);
  });

  it('says so when an upload fails, and stops holding Send', async () => {
    const target = targetOf({
      remote: true,
      upload: () => Promise.reject(new Error('daemon said no')),
    });
    const harness = mount(target);

    harness.attach([file('a.txt', 'text/plain')]);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(harness.error()).toBe('could not upload a.txt: daemon said no');
    expect(harness.uploading()).toBe(false);
    expect(target.delivered).toEqual([]);
  });
});
