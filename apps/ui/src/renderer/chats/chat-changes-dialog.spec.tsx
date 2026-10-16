// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { ChatChangesDialog } from './chat-changes-dialog';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

const START = 'a'.repeat(40);

/** The dialog's own words, from the document it rendered into. */
async function dialogText(
  props: Partial<Parameters<typeof ChatChangesDialog>[0]>,
): Promise<string> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <ChatChangesDialog
        open
        startSha={START}
        changes={[]}
        truncated={false}
        unavailableReason={null}
        error={null}
        loading={false}
        onRefresh={() => undefined}
        onClose={() => undefined}
        {...props}
      />,
    );
  });
  return document.body.textContent ?? '';
}

describe('ChatChangesDialog — what the list is measured against', () => {
  it('names the base it measured against and the ref it came from, not the start', async () => {
    const text = await dialogText({
      upstreamBase: { sha: 'b'.repeat(40), ref: 'origin/master' },
    });
    expect(text).toContain(`Working tree against ${'b'.repeat(12)}`);
    expect(text).toContain('origin/master');
    expect(text).toContain(`This chat started at ${'a'.repeat(12)}`);
    expect(text).not.toContain(`Working tree against ${'a'.repeat(12)}`);
  });

  it('claims no cause for the base moving — a merge of its own commits moves it too', async () => {
    // REVIEWED: the first wording said the chat "has since pulled upstream work
    // in", which is false when the chat's own branch was merged upstream and
    // fetched — the base moves for both, and the header cannot tell which.
    const text = await dialogText({
      upstreamBase: { sha: 'b'.repeat(40), ref: 'origin/main' },
    });
    expect(text).not.toMatch(/pulled/i);
    expect(text).not.toContain("the remote's main branch");
  });

  it('measures against the start when nothing newer is shared', async () => {
    const text = await dialogText({ upstreamBase: null });
    expect(text).toContain(`Working tree against ${'a'.repeat(12)}`);
  });

  it('says the checkout moved off the start, which outranks a shared base', async () => {
    const text = await dialogText({
      movedOffStart: true,
      upstreamBase: { sha: 'b'.repeat(40), ref: 'origin/main' },
    });
    expect(text).toContain(`moved off ${'a'.repeat(12)}`);
    expect(text).not.toContain(`Working tree against ${'b'.repeat(12)}`);
  });
});

describe('ChatChangesDialog — the thread’s other work folders', () => {
  const file = (path: string) => ({
    path,
    status: 'modified' as const,
    diff: null,
    added: 1,
    removed: 1,
  });
  const WORKTREE = '/repo/.claude/worktrees/cw-1256-padding';

  it('lists a worktree’s files under the worktree’s name, apart from the folder’s own', async () => {
    // The same repository-relative path is a different file in each folder, so
    // both rows must be drawn — one tree would merge them into one.
    const text = await dialogText({
      changes: [file('apps/web/card.tsx')],
      elsewhere: [{ folder: WORKTREE, changes: [file('apps/web/card.tsx')] }],
    });

    expect(text).toContain('cw-1256-padding');
    expect(text).toContain('a worktree this chat’s agents worked in');
    expect(text.match(/card\.tsx/g)).toHaveLength(2);
  });

  it('still lists a worktree when the thread’s own folder could not be read, and says why', async () => {
    // The chip counts the worktree either way; a dialog showing only the
    // folder's reason would hide what the chip just stated.
    const text = await dialogText({
      changes: [],
      unavailableReason: 'The commit this chat started at is no longer here.',
      elsewhere: [{ folder: WORKTREE, changes: [file('apps/web/card.tsx')] }],
    });

    expect(text).toContain(
      'The commit this chat started at is no longer here.',
    );
    expect(text).toContain('card.tsx');
  });

  it('is not empty when only a worktree changed', async () => {
    const text = await dialogText({
      changes: [],
      elsewhere: [{ folder: WORKTREE, changes: [file('apps/web/card.tsx')] }],
    });

    expect(text).not.toContain('Nothing has changed in this folder');
    expect(text).toContain('card.tsx');
  });
});
