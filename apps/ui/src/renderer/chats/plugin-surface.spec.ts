import { describe, expect, it } from 'vitest';

import {
  opensPluginLink,
  pluginButtonOf,
  pluginSurfaceOf,
} from './plugin-surface';

const VIEW = [
  { id: 'root', component: 'Column', children: ['title', 'refresh'] },
  { id: 'title', component: 'Text', text: { '@path': '/data/title' } },
  {
    id: 'refresh',
    component: 'Button',
    child: 'refresh_label',
    action: { event: { name: 'refresh', context: {} } },
  },
  { id: 'refresh_label', component: 'Text', text: 'Refresh' },
];

describe('pluginSurfaceOf', () => {
  it('builds a surface whose data model holds the command data, every field filled', () => {
    expect(pluginSurfaceOf('weather', VIEW, { title: 'Rain at noon' })).toEqual(
      {
        surfaceId: 'plugin:weather',
        version: 1,
        title: null,
        components: VIEW,
        dataModel: { data: { title: 'Rain at noon' } },
        drafts: {},
        agentWrites: [],
        overriddenDrafts: [],
        oneShotPressed: [],
        removed: false,
        publisher: { memberId: null, agentLabel: null },
        media: {},
      },
    );
  });

  it('keeps a command with no data as a null data model', () => {
    expect(pluginSurfaceOf('weather', VIEW, null).dataModel).toEqual({
      data: null,
    });
  });
});

describe('pluginButtonOf', () => {
  it("answers the name of a Button's event", () => {
    expect(pluginButtonOf(VIEW, 'refresh')).toBe('refresh');
  });

  it('answers null for a component with no event and for an unknown id', () => {
    expect(pluginButtonOf(VIEW, 'title')).toBeNull();
    expect(pluginButtonOf(VIEW, 'missing')).toBeNull();
  });

  it('answers null for a link button, which names no plugin button', () => {
    const view = [
      {
        id: 'open',
        component: 'Button',
        child: 'open_label',
        action: {
          functionCall: {
            call: 'openUrl',
            args: { url: 'https://example.com' },
          },
        },
      },
    ];
    expect(pluginButtonOf(view, 'open')).toBeNull();
  });
});

describe('opensPluginLink', () => {
  it('opens a web address', () => {
    expect(opensPluginLink('https://example.com/report')).toBe(true);
    expect(opensPluginLink('http://localhost:3000')).toBe(true);
  });

  it('refuses a local path, a file address and a script address', () => {
    expect(opensPluginLink('/Users/x/report.html')).toBe(false);
    expect(opensPluginLink('file:///x')).toBe(false);
    expect(opensPluginLink('javascript:alert(1)')).toBe(false);
  });
});
