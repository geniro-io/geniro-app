import { describe, expect, it } from 'vitest';

import type { HostPluginProposal } from '../chat.types';
import {
  hostPluginResultText,
  pluginCardInput,
  pluginVerdict,
  readHostPluginProposal,
} from './host-plugin';

const PROPOSAL: HostPluginProposal = {
  slug: 'prod-deploys',
  name: 'Prod deploys',
  text: 'name: Prod deploys\ncommand: echo 2\n',
  previousText: null,
  baseHash: null,
  command: 'echo 2',
  folders: ['/srv/deploys'],
  refreshMinutes: 5,
  timeoutSeconds: 30,
  buttons: [{ id: 'retry', command: 'echo retry', confirm: false }],
  view: [{ id: 'root', component: 'Column', children: [] }],
  sample: { items: [] },
};

const UPDATE: HostPluginProposal = {
  ...PROPOSAL,
  text: 'name: Prod deploys\ncommand: echo 2\n',
  previousText: 'name: Prod deploys\ncommand: echo 1\n',
  baseHash: 'hash-1',
};

describe('pluginCardInput', () => {
  it('carries the whole file text as new_string, and no old text for a new plugin', () => {
    const input = pluginCardInput(PROPOSAL);

    expect(input).toMatchObject({
      summary: 'Add plugin Prod deploys',
      slug: 'prod-deploys',
      command: 'echo 2',
      folders: ['/srv/deploys'],
      new_string: PROPOSAL.text,
    });
    expect(input).not.toHaveProperty('old_string');
    expect(input).not.toHaveProperty('diff');
  });

  it('carries the old text and a diff for an update', () => {
    const input = pluginCardInput(UPDATE);

    expect(input).toMatchObject({
      summary: 'Update plugin Prod deploys',
      old_string: UPDATE.previousText,
      new_string: UPDATE.text,
    });
    expect(input.diff).toContain('-command: echo 1\n+command: echo 2');
  });
});

describe('pluginVerdict', () => {
  it('records a save with the slug it was saved as', () => {
    expect(
      pluginVerdict({ status: 'saved', slug: 'prod-deploys', path: '/p.yaml' }),
    ).toEqual({ outcome: 'saved', answer: 'saved as prod-deploys' });
  });

  it('records a stale approval as not saved, with the reason', () => {
    expect(
      pluginVerdict({ status: 'stale', reason: 'the plugin changed' }),
    ).toEqual({ outcome: 'not-saved', answer: 'the plugin changed' });
  });

  it.each([
    ['a rejection', { status: 'declined' as const }],
    ['a card that was posted', { status: 'posted' as const }],
    [
      'a card no one could put up',
      { status: 'unavailable' as const, reason: 'no turn' },
    ],
  ])('records nothing for %s', (_name, outcome) => {
    expect(pluginVerdict(outcome)).toEqual({});
  });
});

describe('readHostPluginProposal', () => {
  it('reads back the proposal it was stored as', () => {
    expect(
      readHostPluginProposal(JSON.parse(JSON.stringify(UPDATE)) as unknown),
    ).toEqual(UPDATE);
  });

  it.each([
    ['no text', { text: undefined }],
    ['a refresh of zero minutes', { refreshMinutes: 0 }],
    [
      'a button whose confirm is not a boolean',
      { buttons: [{ id: 'x', command: 'y', confirm: 'yes' }] },
    ],
    ['folders that are not a list', { folders: '/srv/deploys' }],
    ['a view holding a string', { view: ['root'] }],
  ])('refuses a proposal with %s', (_name, change) => {
    const stored = JSON.parse(
      JSON.stringify({ ...PROPOSAL, ...change }),
    ) as unknown;

    expect(readHostPluginProposal(stored)).toBeNull();
  });

  it('refuses a value that is not an object', () => {
    expect(readHostPluginProposal('save_plugin')).toBeNull();
    expect(readHostPluginProposal(null)).toBeNull();
  });
});

describe('hostPluginResultText', () => {
  it('tells the agent to stop once the card is posted', () => {
    expect(
      hostPluginResultText({ status: 'posted', buttons: 'Save or Discard' }),
    ).toContain('STOP HERE');
  });

  it('does not tell the agent to stop once the card is answered', () => {
    expect(
      hostPluginResultText({
        status: 'saved',
        slug: 'prod-deploys',
        path: '/p.yaml',
      }),
    ).not.toContain('STOP HERE');
  });
});
