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
