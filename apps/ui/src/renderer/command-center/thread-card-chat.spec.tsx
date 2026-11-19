// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DaemonHandle } from '../../shared/contracts';
import type { HostedThread } from '../chats/hosted-thread';
import type { DaemonApis } from '../daemon-api';
import type { DaemonClient } from '../daemon-client';
import { ThreadCardChat } from './thread-card-chat';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { hostedSeen, pageCaps } = vi.hoisted(() => ({
  hostedSeen: [] as HostedThread[],
  pageCaps: [] as (number | undefined)[],
}));
vi.mock('../chats/Chats', async () => {
  const { createElement } = await import('react');
  return {
    Chats: function ChatsStub({
      hosted,
      transcriptPageCap,
    }: {
      hosted: HostedThread;
      transcriptPageCap?: number;
    }): React.JSX.Element {
      hostedSeen.push(hosted);
      pageCaps.push(transcriptPageCap);
      return createElement('div', { 'data-slot': 'chats-stub' });
    },
  };
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  hostedSeen.length = 0;
  pageCaps.length = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('ThreadCardChat', () => {
  it('hosts the thread under the card’s own head: no chat header, its own queue, thread links kept on the page', () => {
    const onOpenThread = vi.fn();
    act(() =>
      root.render(
        <ThreadCardChat
          runId="run-a"
          apis={{} as DaemonApis}
          handle={{ host: '127.0.0.1', port: 1, token: 't' } as DaemonHandle}
          client={{} as DaemonClient}
          active
          onOpenThread={onOpenThread}
          threadIdentities={new Map()}
        />,
      ),
    );

    const hosted = hostedSeen.at(-1)!;
    expect(hosted.hideHeader).toBe(true);
    expect(hosted.queueScope).toBe('command-center-thread:run-a');
    hosted.onOpenThread?.('run-b');
    expect(onOpenThread).toHaveBeenCalledWith('run-b');
  });

  it('reads a first page of 250 rows, as a phone does, not the history page size', () => {
    act(() =>
      root.render(
        <ThreadCardChat
          runId="run-a"
          apis={{} as DaemonApis}
          handle={{ host: '127.0.0.1', port: 1, token: 't' } as DaemonHandle}
          client={{} as DaemonClient}
          active
          onOpenThread={vi.fn()}
          threadIdentities={new Map()}
        />,
      ),
    );

    expect(pageCaps.at(-1)).toBe(250);
  });
});
