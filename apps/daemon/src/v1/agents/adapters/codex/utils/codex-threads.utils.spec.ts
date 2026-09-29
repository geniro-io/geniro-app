import { describe, expect, it } from 'vitest';

import { codexThreadHistory, readCodexThreads } from './codex-threads.utils';

describe('readCodexThreads', () => {
  it('titles a thread by its name, else its opening line, and stamps in ms', () => {
    expect(
      readCodexThreads({
        data: [
          {
            id: '01a0900a-5350-7b52-9c5e-7edf51a32916',
            name: 'Find the best base spots',
            preview: 'Tell me the best places…',
            cwd: '/Users/x/game',
            createdAt: 1789122990,
            updatedAt: 1789129340,
          },
          {
            id: '01a08b53-31c7-7ba2-a6af-9235c634224c',
            name: null,
            preview: '\nHow do I leave this Slack channel?\nmore',
            cwd: '/Users/x',
            createdAt: 1789043880,
            updatedAt: null,
          },
          { name: 'no id' },
        ],
        nextCursor: null,
      }),
    ).toEqual([
      {
        id: '01a0900a-5350-7b52-9c5e-7edf51a32916',
        cwd: '/Users/x/game',
        title: 'Find the best base spots',
        updatedAt: 1789129340_000,
        snippet: null,
      },
      {
        id: '01a08b53-31c7-7ba2-a6af-9235c634224c',
        cwd: '/Users/x',
        title: 'How do I leave this Slack channel?',
        updatedAt: 1789043880_000,
        snippet: null,
      },
    ]);
  });
});

describe('codexThreadHistory', () => {
  /** A `thread/read` shape as read live: a user message, a search, a reply. */
  const RESULT = {
    thread: {
      id: 't',
      turns: [
        {
          id: 'u1',
          items: [
            {
              type: 'userMessage',
              id: 'um',
              content: [
                {
                  type: 'text',
                  text: 'Where should I build?',
                  text_elements: [],
                },
                { type: 'localImage', path: '/tmp/map.png' },
              ],
            },
            {
              type: 'webSearch',
              id: 'ws',
              query: 'satisfactory resource map',
            },
            {
              type: 'agentMessage',
              id: 'am',
              text: 'Near the northern forest.',
              phase: 'final_answer',
            },
          ],
        },
      ],
    },
  };

  it('replays the user’s words, the tool calls and the answers in order', () => {
    expect(codexThreadHistory(RESULT, 100)).toEqual({
      events: [
        { type: 'user_message', text: 'Where should I build?' },
        {
          type: 'tool_call',
          id: 'ws',
          name: 'web_search',
          input: { query: 'satisfactory resource map' },
          kind: 'fetch',
        },
        {
          type: 'tool_result',
          id: 'ws',
          name: 'web_search',
          result: null,
          isError: false,
        },
        { type: 'text', text: 'Near the northern forest.' },
      ],
      droppedBefore: 0,
    });
  });

  it('keeps the newest rows under the limit and counts what it left out', () => {
    const history = codexThreadHistory(RESULT, 1);
    expect(history?.events).toEqual([
      { type: 'text', text: 'Near the northern forest.' },
    ]);
    expect(history?.droppedBefore).toBe(3);
  });

  it('answers null for a reply carrying no thread', () => {
    expect(codexThreadHistory({}, 10)).toBeNull();
  });
});
