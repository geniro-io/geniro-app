// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_SETTINGS,
  type MemoryTriageConfig,
  type Settings,
} from '../../shared/contracts';
import { createPreloadStub } from '../__fixtures__/preload-stub';
import { managerStartRequest } from './manager-start-request';

function stubSettings(overrides: Partial<Settings>): void {
  window.geniro = createPreloadStub({
    getSettings: () => Promise.resolve({ ...DEFAULT_SETTINGS, ...overrides }),
  });
}

describe('managerStartRequest', () => {
  beforeEach(() => {
    stubSettings({});
  });

  it('starts the manager on the picked agent, profile, model, effort, window and parameters, with the user’s instructions and language', async () => {
    stubSettings({
      customInstructions: 'Be brief.',
      replyLanguage: 'Russian',
      agentOptions: { claude: { thinking: true } },
    });
    const choice: MemoryTriageConfig = {
      agent: 'codex',
      configDir: '/Users/me/codex-work',
      model: 'gpt-5.4',
      effort: 'high',
      contextWindow: '272k',
      modelParameters: { fast: 'on' },
    };

    expect(await managerStartRequest(choice)).toEqual({
      agentKind: 'codex',
      configDir: '/Users/me/codex-work',
      model: 'gpt-5.4',
      effort: 'high',
      contextWindow: '272k',
      modelParameters: { fast: 'on' },
      customInstructions: 'Be brief.',
      replyLanguage: 'Russian',
      agentOptions: { claude: { thinking: true } },
    });
  });

  it('leaves out every setting the choice does not make, so a blank choice starts on its agent alone', async () => {
    const blank: MemoryTriageConfig = {
      agent: 'claude',
      configDir: null,
      model: null,
      effort: null,
      contextWindow: null,
      modelParameters: {},
    };

    expect(await managerStartRequest(blank)).toEqual({
      agentKind: 'claude',
      agentOptions: {},
    });
  });
});
