import { describe, expect, it } from 'vitest';

import type {
  HostPluginProposal,
  HostProjectInstructions,
} from '../chat.types';
import {
  readTeamProjectCard,
  serializeTeamProjectCard,
  teamProjectCardId,
  teamProjectCardTool,
} from './team-project-card';

const CHANGE: HostProjectInstructions = {
  projectId: 'p-billing',
  project: 'Billing',
  previous: null,
  next: 'Use pnpm.',
  blocks: [{ id: 'b1', title: '', text: 'Use pnpm.' }],
  baseRevision: 2,
  ids: ['P-1', 'P-2'],
  cardSeq: 9,
};

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
  buttons: [],
  view: [{ id: 'root', component: 'Column', children: [] }],
  sample: null,
};

describe('team project card', () => {
  it('reads a row written before plugin cards as a project card', () => {
    const legacy = JSON.stringify({ requestId: 'req-p', change: CHANGE });

    expect(readTeamProjectCard(legacy)).toEqual({
      kind: 'project',
      requestId: 'req-p',
      change: CHANGE,
    });
    expect(teamProjectCardTool(legacy)).toBe('save_project_instructions');
  });

  it('reads a plugin row', () => {
    const plugin = {
      kind: 'plugin' as const,
      requestId: 'req-plugin',
      proposal: PROPOSAL,
    };

    expect(readTeamProjectCard(serializeTeamProjectCard(plugin))).toEqual(
      plugin,
    );
  });

  it('names save_plugin for a plugin row and save_project_instructions otherwise', () => {
    const plugin = serializeTeamProjectCard({
      kind: 'plugin',
      requestId: 'req-plugin',
      proposal: PROPOSAL,
    });
    const project = serializeTeamProjectCard({
      kind: 'project',
      requestId: 'req-p',
      change: CHANGE,
    });

    expect(teamProjectCardTool(plugin)).toBe('save_plugin');
    expect(teamProjectCardTool(project)).toBe('save_project_instructions');
    expect(teamProjectCardTool(null)).toBe('save_project_instructions');
  });

  it('keeps the id of a plugin row whose proposal no longer reads, so it can still be closed', () => {
    const stored = JSON.stringify({
      kind: 'plugin',
      requestId: 'req-plugin',
      proposal: { ...PROPOSAL, refreshMinutes: 0 },
    });

    expect(readTeamProjectCard(stored)).toBeNull();
    expect(teamProjectCardId(stored)).toBe('req-plugin');
  });

  it('refuses a row whose kind is neither project nor plugin', () => {
    expect(
      readTeamProjectCard(
        JSON.stringify({ kind: 'patch', requestId: 'req-x', change: CHANGE }),
      ),
    ).toBeNull();
  });
});
