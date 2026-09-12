import { describe, expect, it } from 'vitest';

import { reportImagePaths } from './report-images';
import {
  composeTaskPrompt,
  TASK_REPORT_INSTRUCTIONS,
  TASK_REPORT_INSTRUCTIONS_WORKFLOW,
} from './task-prompt';

describe('the report instructions — screenshots', () => {
  it('ask both engines for them in the ONE shape the settle collects', () => {
    // The example the instruction gives must itself be something the settle
    // would attach, or the agent is taught a form that is silently dropped.
    for (const text of [
      TASK_REPORT_INSTRUCTIONS,
      TASK_REPORT_INSTRUCTIONS_WORKFLOW,
    ]) {
      expect(text).toMatch(/screenshot/i);
      expect(reportImagePaths(text)).toEqual(['/absolute/path/to/image.png']);
    }
  });
});

/**
 * The half that makes attaching mean anything.
 *
 * A card can carry files; without this the agent working it is never told they
 * exist, and the feature is a list in a panel.
 */
describe('composeTaskPrompt — attached files', () => {
  const file = (path: string) => ({
    id: 'a1',
    name: path.split('/').pop() ?? path,
    path,
    bytes: 10,
  });

  it('names each one by PATH, which is all an agent needs', () => {
    const prompt = composeTaskPrompt(
      { title: 'Ship it', description: 'do the thing' },
      [file('/u/bundle.zip')],
    );

    expect(prompt).toContain('/u/bundle.zip');
  });

  it('puts them LAST, behind the brief', () => {
    // The prompt is what a CLI names the conversation from, so a list of paths
    // at the top titles the chat after somebody's Downloads folder.
    const prompt = composeTaskPrompt({ title: 'Ship it', description: null }, [
      file('/u/bundle.zip'),
    ]);

    expect(prompt.indexOf('Ship it')).toBeLessThan(
      prompt.indexOf('/u/bundle.zip'),
    );
  });

  it('adds nothing at all to a card with no files', () => {
    expect(composeTaskPrompt({ title: 'Ship it', description: null })).toBe(
      'Ship it',
    );
  });
});
