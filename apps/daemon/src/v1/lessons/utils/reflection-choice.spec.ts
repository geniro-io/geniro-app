import { describe, expect, it } from 'vitest';

import type { Run } from '../../runs/entity/run.entity';
import { AgentKind } from '../../runs/runs.types';
import type { LessonsConfig, ReflectLessons } from '../lessons.types';
import { reflectionChoiceOf } from './reflection-choice';

const NO_SETTINGS: LessonsConfig = {
  mode: 'offer',
  agentKind: null,
  model: null,
  effort: null,
  quietWindowHours: 3,
};

function source(overrides: Partial<Pick<Run, 'agentKind' | 'configDir'>> = {}) {
  return {
    agentKind: AgentKind.Claude,
    configDir: '/cfg/claude',
    ...overrides,
  } as Pick<Run, 'agentKind' | 'configDir'>;
}

describe('reflectionChoiceOf', () => {
  it.each<
    [
      string,
      Partial<LessonsConfig>,
      Partial<Pick<Run, 'agentKind' | 'configDir'>>,
      Partial<ReflectLessons>,
      {
        agentKind: string;
        model: string | null;
        effort: string | null;
        configDir: string | null;
      },
    ]
  >([
    [
      'nothing named: the thread’s own CLI, its folder and the CLI default',
      {},
      {},
      {},
      {
        agentKind: 'claude',
        model: null,
        effort: null,
        configDir: '/cfg/claude',
      },
    ],
    [
      'the settings agent, model and effort, when the press names nothing',
      { agentKind: 'codex', model: 'gpt-settings', effort: 'high' },
      {},
      {},
      {
        agentKind: 'codex',
        model: 'gpt-settings',
        effort: 'high',
        configDir: null,
      },
    ],
    [
      'a settings agent this daemon does not know: the thread’s own CLI, and no settings model',
      { agentKind: 'gemini', model: 'gemini-settings', effort: 'high' },
      {},
      {},
      {
        agentKind: 'claude',
        model: null,
        effort: null,
        configDir: '/cfg/claude',
      },
    ],
    [
      'settings with no agent: the thread’s own CLI keeps the settings model',
      { agentKind: null, model: 'haiku', effort: 'low' },
      {},
      {},
      {
        agentKind: 'claude',
        model: 'haiku',
        effort: 'low',
        configDir: '/cfg/claude',
      },
    ],
    [
      'a press agent beats the settings agent, and drops the settings model and effort',
      { agentKind: 'codex', model: 'gpt-settings', effort: 'high' },
      {},
      { agentKind: AgentKind.Claude },
      {
        agentKind: 'claude',
        model: null,
        effort: null,
        configDir: '/cfg/claude',
      },
    ],
    [
      'a press model, effort and folder beat the settings and the thread',
      { model: 'haiku', effort: 'low' },
      {},
      { model: 'opus', effort: 'max', configDir: '/cfg/press' },
      {
        agentKind: 'claude',
        model: 'opus',
        effort: 'max',
        configDir: '/cfg/press',
      },
    ],
    [
      'a press naming another agent keeps the thread’s config folder off: it was the other CLI’s',
      {},
      {},
      { agentKind: AgentKind.Codex },
      { agentKind: 'codex', model: null, effort: null, configDir: null },
    ],
    [
      'a thread with no agent of its own runs as Claude',
      {},
      { agentKind: null as unknown as Run['agentKind'] },
      {},
      { agentKind: 'claude', model: null, effort: null, configDir: null },
    ],
  ])('%s', (_, settings, thread, press, expected) => {
    expect(
      reflectionChoiceOf(
        { ...NO_SETTINGS, ...settings },
        source(thread),
        press,
      ),
    ).toEqual(expected);
  });
});
