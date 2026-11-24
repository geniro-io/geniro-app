// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  FileLines,
  GitChange,
  ReadFileLinesRequest,
} from '../../shared/contracts';
import { ChangesReviewDialog } from './changes-review-dialog';
import { ThreadUiMemoryContext } from './thread-ui-memory';
import type { ReviewComment, ReviewController } from './use-review-comments';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type DialogProps = Parameters<typeof ChangesReviewDialog>[0];

const FOLDER = '/work/shop';
const THREAD = 'run-1';
const START = 'a'.repeat(40);
const BASE = 'b'.repeat(40);

function change(over: Partial<GitChange> & Pick<GitChange, 'path'>): GitChange {
  return {
    status: 'modified',
    oldPath: null,
    diff: null,
    added: null,
    removed: null,
    ...over,
  };
}

const TS_BODY = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -20,3 +20,4 @@ export function total(items: Item[]) {',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  '+const extra = 4;',
  ' const c = 5;',
].join('\n');

const FILE_A = change({
  path: 'src/a.ts',
  diff: TS_BODY,
  added: 2,
  removed: 1,
});

const FILE_A_EDITED = change({
  path: 'src/a.ts',
  diff: TS_BODY.replace('const extra = 4;', 'const extra = 40;'),
  added: 2,
  removed: 1,
});

const FILE_B = change({
  path: 'src/b.ts',
  diff: [
    'diff --git a/src/b.ts b/src/b.ts',
    'index 3333333..4444444 100644',
    '--- a/src/b.ts',
    '+++ b/src/b.ts',
    '@@ -1,2 +1,2 @@',
    '-export const limit = 10;',
    '+export const limit = 20;',
    ' export const other = 1;',
  ].join('\n'),
  added: 1,
  removed: 1,
});

const FILE_BINARY = change({
  path: 'img/logo.png',
  diff: [
    'diff --git a/img/logo.png b/img/logo.png',
    'index 5555555..6666666 100644',
    'Binary files a/img/logo.png and b/img/logo.png differ',
  ].join('\n'),
});

const FILE_CUT_SHORT = change({
  path: 'src/long.ts',
  diff: [
    'diff --git a/src/long.ts b/src/long.ts',
    'index 7777777..8888888 100644',
    '--- a/src/long.ts',
    '+++ b/src/long.ts',
    '@@ -1,2 +1,2 @@',
    '-const x = 1;',
    '+const x = 2;',
    ' const y = 2;',
    '',
    '… 3 more lines — open the file to read the rest.',
  ].join('\n'),
  added: 1,
  removed: 1,
});

const FILE_UNTRACKED = change({
  path: 'notes/todo.md',
  status: 'untracked',
  diff: null,
});

function comment(over: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: 'c1',
    number: 1,
    folder: FOLDER,
    path: 'src/a.ts',
    side: 'new',
    startLine: 21,
    endLine: 21,
    quote: 'const b = 3;',
    body: 'Extract this into a function.',
    status: 'draft',
    sentSeq: null,
    sentAt: null,
    agentStatus: null,
    agentReply: null,
    agentRepliedAt: null,
    agentMemberId: null,
    createdAt: '2026-11-24T10:00:00.000Z',
    updatedAt: '2026-11-24T10:00:00.000Z',
    ...over,
  };
}

function sent(over: Partial<ReviewComment> = {}): ReviewComment {
  return comment({
    status: 'sent',
    sentSeq: 7,
    sentAt: '2026-11-24T10:01:00.000Z',
    ...over,
  });
}

function review(over: Partial<ReviewController> = {}): ReviewController {
  return {
    comments: [],
    error: null,
    add: vi.fn(async () => undefined),
    edit: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    setStatus: vi.fn(async () => undefined),
    send: vi.fn(async () => undefined),
    sending: 'idle',
    cancelWaiting: vi.fn(),
    ...over,
  };
}

function screen(over: Partial<DialogProps> = {}): DialogProps {
  return {
    open: true,
    folder: FOLDER,
    startSha: START,
    baseSha: BASE,
    threadId: THREAD,
    changes: [FILE_A, FILE_B],
    truncated: false,
    unavailableReason: null,
    error: null,
    loading: false,
    upstreamBase: null,
    review: review(),
    onRefresh: () => undefined,
    onClose: () => undefined,
    ...over,
  };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;
const originalMatchMedia = window.matchMedia;

async function update(props: DialogProps): Promise<void> {
  await act(async () => {
    root!.render(
      <ThreadUiMemoryContext.Provider value={THREAD}>
        <ChangesReviewDialog {...props} />
      </ThreadUiMemoryContext.Provider>,
    );
  });
}

async function mount(props: DialogProps): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await update(props);
}

async function unmount(): Promise<void> {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
}

function stubViewport(narrow: boolean): void {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: narrow,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }));
}

afterEach(async () => {
  await unmount();
  localStorage.clear();
  if (originalMatchMedia === undefined) {
    Reflect.deleteProperty(window, 'matchMedia');
  } else {
    window.matchMedia = originalMatchMedia;
  }
});

beforeEach(() => {
  localStorage.clear();
});

function text(): string {
  return document.body.textContent ?? '';
}

function leaf(value: string): boolean {
  return [...document.querySelectorAll('*')].some(
    (el) => el.children.length === 0 && el.textContent?.trim() === value,
  );
}

function control(name: string): HTMLElement | null {
  return (
    [
      ...document.querySelectorAll<HTMLElement>(
        'button, textarea, input, select, [role="checkbox"]',
      ),
    ].find(
      (el) =>
        el.getAttribute('aria-label') === name ||
        (el.textContent ?? '').trim() === name,
    ) ?? null
  );
}

function must(name: string): HTMLElement {
  const found = control(name);
  if (found === null) {
    throw new Error('no control named "' + name + '"');
  }
  return found;
}

function sendHeader(): HTMLButtonElement {
  const found = [
    ...document.querySelectorAll<HTMLButtonElement>('button'),
  ].find((button) =>
    (button.textContent ?? '').trim().startsWith('Send review'),
  );
  if (found === undefined) {
    throw new Error('no Send review button');
  }
  return found;
}

function editor(): HTMLTextAreaElement {
  const field = document.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Review comment"]',
  );
  if (field === null) {
    throw new Error('no review comment editor');
  }
  return field;
}

function moreLinesControls(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('button')].filter(
    (el) =>
      /more lines/.test(el.textContent ?? '') ||
      /more lines/.test(el.getAttribute('aria-label') ?? ''),
  );
}

async function press(
  el: HTMLElement,
  init: MouseEventInit = {},
): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, ...init }));
  });
}

async function typeInto(
  field: HTMLTextAreaElement,
  value: string,
): Promise<void> {
  const setValue = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    'value',
  )!.set!;
  await act(async () => {
    setValue.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function keyDown(el: Element, init: KeyboardEventInit): Promise<void> {
  await act(async () => {
    el.dispatchEvent(
      new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        ...init,
      }),
    );
  });
}

describe('ChangesReviewDialog — the screen', () => {
  it('reads the folder again when it opens and each time the window comes back into focus, and stops once closed', async () => {
    const onRefresh = vi.fn();
    await mount(screen({ onRefresh }));

    expect(onRefresh).toHaveBeenCalledTimes(1);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(onRefresh).toHaveBeenCalledTimes(2);

    await unmount();
    window.dispatchEvent(new Event('focus'));
    expect(onRefresh).toHaveBeenCalledTimes(2);
  });

  it('wraps long code and long comments inside the card instead of scrolling it sideways', async () => {
    const long = 'word'.repeat(400);
    await mount(
      screen({
        changes: [FILE_A],
        review: review({
          comments: [
            sent({ body: long, agentReply: long, agentStatus: 'fixed' }),
          ],
        }),
      }),
    );

    const diff = document.querySelector('[data-slot="review-diff"]')!;
    expect(diff.querySelector('.min-w-max, .overflow-x-auto')).toBeNull();
    const code = [...diff.querySelectorAll('span')].find(
      (el) => el.textContent === 'const b = 3;' && el.children.length === 0,
    );
    expect(code?.closest('.whitespace-pre-wrap')).not.toBeNull();
    const texts = [...diff.querySelectorAll('p')].filter(
      (el) => el.textContent === long,
    );
    expect(texts).toHaveLength(2);
    for (const el of texts) {
      expect(el.className).toContain('break-words');
    }
  });

  it('opens as "Review changes" and lists every changed file, in the tree and as a card, with its +N −M', async () => {
    await mount(screen());

    expect(text()).toContain('Review changes');
    const tree = document.querySelector(
      'nav[aria-label="Changed files"]',
    )!.textContent;
    expect(tree).toContain('a.ts');
    expect(tree).toContain('b.ts');
    expect(text().match(/src\/a\.ts/g)!.length).toBeGreaterThanOrEqual(1);
    expect(text().match(/src\/b\.ts/g)!.length).toBeGreaterThanOrEqual(1);
    expect(text()).toContain('+2');
    expect(text()).toContain('−1');
  });

  it('closes on Escape', async () => {
    const onClose = vi.fn();
    await mount(screen({ onClose }));

    await keyDown(document.activeElement ?? document.body, { key: 'Escape' });

    expect(onClose).toHaveBeenCalled();
  });

  it('closes from the close button', async () => {
    const onClose = vi.fn();
    await mount(screen({ onClose }));

    await press(must('Close'));

    expect(onClose).toHaveBeenCalled();
  });
});

describe('ChangesReviewDialog — what a file’s diff shows', () => {
  it('shows old and new line numbers and the hunk band of a modified file', async () => {
    await mount(screen({ changes: [FILE_A] }));

    expect(text()).toContain('@@ -20,3 +20,4 @@');
    expect(text()).toContain('export function total');
    expect(leaf('21')).toBe(true);
    expect(leaf('23')).toBe(true);
  });

  it('says a binary file is binary', async () => {
    await mount(screen({ changes: [FILE_BINARY] }));

    expect(text()).toMatch(/binary/i);
  });

  it('says how many lines were left out of a body cut short', async () => {
    await mount(screen({ changes: [FILE_CUT_SHORT] }));

    expect(text()).toMatch(/3 more lines/);
  });

  it('says the contents of an untracked file with no body are not shown', async () => {
    await mount(screen({ changes: [FILE_UNTRACKED] }));

    expect(text()).toContain('notes/todo.md');
    expect(text()).toContain('new · not staged');
    expect(text()).toMatch(/not shown/i);
  });
});

describe('ChangesReviewDialog — Viewed', () => {
  it('folds a file once ticked Viewed, and counts it in the header', async () => {
    await mount(screen({ changes: [FILE_A, FILE_B] }));
    expect(text()).toContain('0 of 2 viewed');

    await press(must('Viewed src/a.ts'));

    expect(text()).toContain('1 of 2 viewed');
    expect(text()).not.toContain('@@ -20,3 +20,4 @@');
    expect(text()).toContain('@@ -1,2 +1,2 @@');
  });

  it('unticks a file whose diff changed since it was viewed, and says so', async () => {
    await mount(screen({ changes: [FILE_A] }));
    await press(must('Viewed src/a.ts'));

    await update(screen({ changes: [FILE_A_EDITED] }));

    expect(text()).toContain('Changed since you viewed it');
    expect(must('Viewed src/a.ts').getAttribute('aria-checked')).toBe('false');
    expect(text()).toContain('@@ -20,3 +20,4 @@');
  });

  it('keeps the tick for the thread when the screen is closed and opened again', async () => {
    await mount(screen({ changes: [FILE_A, FILE_B] }));
    await press(must('Viewed src/a.ts'));
    await unmount();

    await mount(screen({ changes: [FILE_A, FILE_B] }));

    expect(text()).toContain('1 of 2 viewed');
  });
});

describe('ChangesReviewDialog — line comments', () => {
  it('adds a line comment with its line and that line’s text as the quote', async () => {
    const ctl = review();
    await mount(screen({ changes: [FILE_A], review: ctl }));

    await press(must('Comment on new line 21'));
    await typeInto(editor(), 'Extract this into a function.');
    await press(must('Add to review'));

    expect(ctl.add).toHaveBeenCalledWith({
      folder: FOLDER,
      path: 'src/a.ts',
      side: 'new',
      startLine: 21,
      endLine: 21,
      quote: 'const b = 3;',
      body: 'Extract this into a function.',
    });
  });

  it('adds the comment on Cmd+Enter or Ctrl+Enter', async () => {
    for (const modifier of [{ metaKey: true }, { ctrlKey: true }]) {
      const ctl = review();
      await mount(screen({ changes: [FILE_A], review: ctl }));
      await press(must('Comment on new line 21'));
      await typeInto(editor(), 'Keyboard add');

      await keyDown(editor(), { key: 'Enter', ...modifier });

      expect(ctl.add).toHaveBeenCalledWith(
        expect.objectContaining({ startLine: 21, body: 'Keyboard add' }),
      );
      await unmount();
    }
  });

  it('refuses an empty comment', async () => {
    const ctl = review();
    await mount(screen({ changes: [FILE_A], review: ctl }));

    await press(must('Comment on new line 21'));
    await typeInto(editor(), '   ');
    await press(must('Add to review'));

    expect(ctl.add).not.toHaveBeenCalled();
  });

  it('covers a range from the first line number clicked to the one Shift-clicked', async () => {
    const ctl = review();
    await mount(screen({ changes: [FILE_A], review: ctl }));

    await press(must('Comment on new line 21'));
    await press(must('Comment on new line 22'), { shiftKey: true });
    await typeInto(editor(), 'Both lines');
    await press(must('Add to review'));

    expect(ctl.add).toHaveBeenCalledWith({
      folder: FOLDER,
      path: 'src/a.ts',
      side: 'new',
      startLine: 21,
      endLine: 22,
      quote: 'const b = 3;\nconst extra = 4;',
      body: 'Both lines',
    });
  });

  it('adds a whole-file comment with no lines and no quote', async () => {
    const ctl = review();
    await mount(screen({ changes: [FILE_A], review: ctl }));

    await press(must('Comment on src/a.ts'));
    await typeInto(editor(), 'Split this file in two.');
    await press(must('Add to review'));

    expect(ctl.add).toHaveBeenCalledWith({
      folder: FOLDER,
      path: 'src/a.ts',
      side: 'file',
      startLine: null,
      endLine: null,
      quote: '',
      body: 'Split this file in two.',
    });
  });

  it('shows a draft as Draft, and Delete removes it', async () => {
    const ctl = review({ comments: [comment()] });
    await mount(screen({ changes: [FILE_A], review: ctl }));

    expect(text()).toContain('Draft');
    await press(must('Delete'));

    expect(ctl.remove).toHaveBeenCalledWith('c1');
  });

  it('Edit, then Add to review, changes the body of a draft', async () => {
    const ctl = review({ comments: [comment()] });
    await mount(screen({ changes: [FILE_A], review: ctl }));

    await press(must('Edit'));
    await typeInto(editor(), 'Changed body');
    await press(must('Add to review'));

    expect(ctl.edit).toHaveBeenCalledWith('c1', 'Changed body');
  });
});

describe('ChangesReviewDialog — Send review', () => {
  it('shows the draft count and lists the drafts before sending, with an optional note', async () => {
    const ctl = review({
      comments: [
        comment({ id: 'c1', number: 1, body: 'First draft' }),
        comment({
          id: 'c2',
          number: 2,
          path: 'src/b.ts',
          startLine: 1,
          endLine: 1,
          quote: 'export const limit = 20;',
          body: 'Second draft',
        }),
      ],
    });
    await mount(screen({ changes: [FILE_A, FILE_B], review: ctl }));
    expect(text()).toContain('Send review · 2');

    await press(sendHeader());
    expect(text()).toContain('First draft');
    expect(text()).toContain('Second draft');
    await typeInto(
      document.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Review note"]',
      )!,
      'Please check the sums',
    );
    await press(must('Send review'));

    expect(ctl.send).toHaveBeenCalledWith('Please check the sums');
  });

  it('sends with null when no note is given', async () => {
    const ctl = review({ comments: [comment()] });
    await mount(screen({ changes: [FILE_A], review: ctl }));

    await press(sendHeader());
    await press(must('Send review'));

    expect(ctl.send).toHaveBeenCalledWith(null);
  });

  it('disables Send review when there are no drafts', async () => {
    await mount(
      screen({ changes: [FILE_A], review: review({ comments: [] }) }),
    );

    expect(sendHeader().disabled).toBe(true);
  });
});

describe('ChangesReviewDialog — the agent’s answers', () => {
  it('shows a sent comment with the agent’s reply and its status', async () => {
    const ctl = review({
      comments: [
        sent({
          agentStatus: 'fixed',
          agentReply: 'Moved the sum into its own function.',
          agentRepliedAt: '2026-11-24T10:05:00.000Z',
          agentMemberId: 'dev',
        }),
      ],
    });
    await mount(screen({ changes: [FILE_A], review: ctl }));

    expect(text()).toContain('Moved the sum into its own function.');
    expect(text()).toContain('Agent: fixed');
  });

  it('Resolve sends the comment to resolved, and a resolved comment folds to a line with Open', async () => {
    const ctl = review({
      comments: [sent({ agentStatus: 'fixed', agentReply: 'Done.' })],
    });
    await mount(screen({ changes: [FILE_A], review: ctl }));

    await press(must('Resolve'));
    expect(ctl.setStatus).toHaveBeenCalledWith('c1', 'resolved');

    await update(
      screen({
        changes: [FILE_A],
        review: review({
          comments: [
            sent({
              status: 'resolved',
              agentStatus: 'fixed',
              agentReply: 'Done.',
            }),
          ],
        }),
      }),
    );
    expect(text()).not.toContain('Extract this into a function.');
    expect(control('Open')).not.toBeNull();
  });

  it('Not fixed reopens an answered comment', async () => {
    const ctl = review({
      comments: [sent({ agentStatus: 'fixed', agentReply: 'Done.' })],
    });
    await mount(screen({ changes: [FILE_A], review: ctl }));

    await press(must('Not fixed'));

    expect(ctl.setStatus).toHaveBeenCalledWith('c1', 'sent');
  });

  it('shows Outdated and the original quote when the quoted line is gone', async () => {
    const ctl = review({
      comments: [
        sent({ quote: 'const gone = 1;', startLine: 30, endLine: 30 }),
      ],
    });
    await mount(screen({ changes: [FILE_A], review: ctl }));

    expect(text()).toContain('Outdated');
    expect(text()).toContain('const gone = 1;');
  });
});

describe('ChangesReviewDialog — more lines', () => {
  it('Show more lines above reads them through readFileLines and inserts them with their numbers', async () => {
    const readFileLines = vi.fn(
      async (request: ReadFileLinesRequest): Promise<FileLines> => ({
        lines: Array.from(
          { length: request.to - request.from + 1 },
          (_, i) => 'const hidden' + (request.from + i) + ' = 0;',
        ),
        total: 40,
        unavailableReason: null,
      }),
    );
    await mount(screen({ changes: [FILE_A], readFileLines }));

    await press(must('Show 19 more lines above'));

    expect(readFileLines).toHaveBeenCalledWith(
      expect.objectContaining({
        dir: FOLDER,
        path: 'src/a.ts',
        from: 1,
        to: 19,
      }),
    );
    expect(text()).toContain('const hidden7 = 0;');
    expect(leaf('7')).toBe(true);
  });

  it('labels the rows below with how many the file has left, not a full step', async () => {
    const readFileLines = vi.fn(async (): Promise<FileLines> => ({
      lines: ['const c = 5;'],
      total: 30,
      unavailableReason: null,
    }));
    await mount(screen({ changes: [FILE_A], readFileLines }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(control('Show 7 more lines below')).not.toBeNull();
    expect(control('Show 20 more lines below')).toBeNull();
  });

  it('offers no way to show more lines without readFileLines', async () => {
    await mount(screen({ changes: [FILE_A] }));

    expect(moreLinesControls()).toHaveLength(0);
  });
});

describe('ChangesReviewDialog — a phone-width screen', () => {
  it('draws one file at a time, picked from File, with Previous and Next', async () => {
    stubViewport(true);
    await mount(screen({ changes: [FILE_A, FILE_B] }));

    expect(control('File')).not.toBeNull();
    expect(text()).toContain('@@ -20,3 +20,4 @@');
    expect(text()).not.toContain('@@ -1,2 +1,2 @@');

    await press(must('Next file'));
    expect(text()).toContain('@@ -1,2 +1,2 @@');
    expect(text()).not.toContain('@@ -20,3 +20,4 @@');

    await press(must('Previous file'));
    expect(text()).toContain('@@ -20,3 +20,4 @@');
  });

  it('still adds comments and sends the review', async () => {
    stubViewport(true);
    const ctl = review({ comments: [comment({ id: 'c1', number: 1 })] });
    await mount(screen({ changes: [FILE_A], review: ctl }));

    await press(must('Comment on new line 21'));
    await typeInto(editor(), 'Narrow comment');
    await press(must('Add to review'));
    expect(ctl.add).toHaveBeenCalledWith(
      expect.objectContaining({ startLine: 21, body: 'Narrow comment' }),
    );

    await press(sendHeader());
    await press(must('Send review'));
    expect(ctl.send).toHaveBeenCalledWith(null);
  });
});

describe('ChangesReviewDialog — what the list is measured against', () => {
  it('names the base it measured against and the ref it came from, not the start', async () => {
    await mount(
      screen({ upstreamBase: { sha: 'c'.repeat(40), ref: 'origin/master' } }),
    );

    expect(text()).toContain('Working tree against ' + 'c'.repeat(12));
    expect(text()).toContain('origin/master');
    expect(text()).toContain('This chat started at ' + 'a'.repeat(12));
    expect(text()).not.toContain('Working tree against ' + 'a'.repeat(12));
    expect(text()).not.toMatch(/pulled/i);
  });

  it('measures against the start when nothing newer is shared', async () => {
    await mount(screen({ upstreamBase: null }));

    expect(text()).toContain('Working tree against ' + 'a'.repeat(12));
  });

  it('says the checkout moved off the start, which outranks a shared base', async () => {
    await mount(
      screen({
        movedOffStart: true,
        upstreamBase: { sha: 'c'.repeat(40), ref: 'origin/main' },
      }),
    );

    expect(text()).toContain('moved off ' + 'a'.repeat(12));
    expect(text()).not.toContain('Working tree against ' + 'c'.repeat(12));
  });
});

describe('ChangesReviewDialog — the thread’s other work folders', () => {
  const WORKTREE = '/repo/.claude/worktrees/cw-1256-padding';
  const elsewhereFile = change({
    path: 'src/a.ts',
    diff: TS_BODY,
    added: 2,
    removed: 1,
  });

  it('lists a worktree’s files under the worktree’s name, apart from the folder’s own', async () => {
    await mount(
      screen({
        changes: [FILE_A],
        elsewhere: [
          {
            folder: WORKTREE,
            changes: [elsewhereFile],
            upstreamBase: null,
            baseSha: null,
          },
        ],
      }),
    );

    expect(text()).toContain('cw-1256-padding');
    expect(text()).toContain('a worktree this chat’s agents worked in');
    expect(text()).toContain('0 of 2 viewed');
  });

  it('names the ref a worktree is measured against', async () => {
    await mount(
      screen({
        elsewhere: [
          {
            folder: WORKTREE,
            changes: [elsewhereFile],
            upstreamBase: { sha: 'd'.repeat(40), ref: 'origin/feature/stack' },
            baseSha: null,
          },
        ],
      }),
    );

    expect(text()).toContain('worked in, against origin/feature/stack');
  });

  it('still lists a worktree when the thread’s own folder could not be read, and says why', async () => {
    await mount(
      screen({
        changes: [],
        unavailableReason: 'The commit this chat started at is no longer here.',
        elsewhere: [
          {
            folder: WORKTREE,
            changes: [elsewhereFile],
            upstreamBase: null,
            baseSha: null,
          },
        ],
      }),
    );

    expect(text()).toContain(
      'The commit this chat started at is no longer here.',
    );
    expect(text()).toContain('src/a.ts');
    expect(text()).not.toContain('Nothing has changed in this folder');
  });

  it('makes a comment in a worktree’s file in that worktree’s folder', async () => {
    const ctl = review();
    await mount(
      screen({
        changes: [],
        review: ctl,
        elsewhere: [
          {
            folder: WORKTREE,
            changes: [elsewhereFile],
            upstreamBase: null,
            baseSha: null,
          },
        ],
      }),
    );

    await press(must('Comment on new line 21'));
    await typeInto(editor(), 'In the worktree');
    await press(must('Add to review'));

    expect(ctl.add).toHaveBeenCalledWith(
      expect.objectContaining({
        folder: WORKTREE,
        path: 'src/a.ts',
        startLine: 21,
      }),
    );
  });
});

describe('ChangesReviewDialog — comments outside the diff', () => {
  const linesFrom = (from: number, to: number, text: (n: number) => string) =>
    Array.from({ length: to - from + 1 }, (_, i) => text(from + i));

  it('places a comment on a revealed line beside it, not as Outdated', async () => {
    const readFileLines = vi.fn(
      async (request: ReadFileLinesRequest): Promise<FileLines> => ({
        lines: linesFrom(
          request.from,
          request.to,
          (n) => 'const line' + n + ' = 0;',
        ),
        total: 40,
        unavailableReason: null,
      }),
    );
    const ctl = review({
      comments: [
        sent({
          startLine: 7,
          endLine: 7,
          quote: 'const line7 = 0;',
          body: 'On a revealed line',
        }),
      ],
    });
    await mount(screen({ changes: [FILE_A], review: ctl, readFileLines }));

    await press(must('Show 19 more lines above'));

    expect(text()).toContain('On a revealed line');
    expect(text()).not.toContain('Outdated');
  });

  it('does not call a comment Outdated when its lines outside the diff still read the same on disk', async () => {
    const readFileLines = vi.fn(
      async (request: ReadFileLinesRequest): Promise<FileLines> => ({
        lines: linesFrom(request.from, request.to, () => 'const kept = 1;'),
        total: 40,
        unavailableReason: null,
      }),
    );
    const ctl = review({
      comments: [
        sent({
          startLine: 30,
          endLine: 30,
          quote: 'const kept = 1;',
          body: 'Far below',
        }),
      ],
    });
    await mount(screen({ changes: [FILE_A], review: ctl, readFileLines }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(readFileLines).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'src/a.ts', from: 30, to: 30 }),
    );
    expect(text()).toContain('Far below');
    expect(text()).not.toContain('Outdated');
  });

  it('keeps a range that starts above the hunk at its line, read from disk before the rows above are shown', async () => {
    const onDisk = (n: number): string =>
      ({
        20: 'const a = 1;',
        21: 'const b = 3;',
        22: 'const extra = 4;',
        23: 'const c = 5;',
      })[n] ?? 'const line' + n + ' = 0;';
    const readFileLines = vi.fn(
      async (request: ReadFileLinesRequest): Promise<FileLines> => ({
        lines: linesFrom(request.from, request.to, onDisk),
        total: 40,
        unavailableReason: null,
      }),
    );
    const ctl = review({
      comments: [
        comment({
          startLine: 18,
          endLine: 21,
          quote: [18, 19, 20, 21].map(onDisk).join('\n'),
          body: 'Across the hunk edge',
        }),
      ],
    });
    await mount(screen({ changes: [FILE_A], review: ctl, readFileLines }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(text()).toContain('Across the hunk edge');
    expect(text()).not.toContain('Outdated');

    await press(must('Show 19 more lines above'));

    expect(text()).toContain('Across the hunk edge');
    expect(text()).not.toContain('Outdated');
  });

  it('lists a draft on a file that is no longer changed, where it can still be deleted', async () => {
    const ctl = review({
      comments: [comment({ path: 'src/gone.ts', body: 'On a vanished file' })],
    });
    await mount(screen({ changes: [FILE_A], review: ctl }));

    expect(text()).toContain('No longer changed');
    expect(text()).toContain('On a vanished file');
    await press(must('Delete'));
    expect(ctl.remove).toHaveBeenCalledWith('c1');
  });
});

describe('ChangesReviewDialog — opened from the transcript', () => {
  it('says a comment it was opened at no longer exists', async () => {
    await mount(screen({ changes: [FILE_A], focusComment: 4 }));

    expect(text()).toContain('Comment #4 was deleted.');
  });
});
