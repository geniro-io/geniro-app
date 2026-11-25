import { describe, expect, it } from 'vitest';

import {
  changedInstructionsNote,
  readConversationInstructions,
  teamInstructionsHashOf,
} from './conversation-instructions';

describe('changedInstructionsNote', () => {
  it('hands over the new team instructions, trimmed, as replacing the earlier ones', () => {
    expect(changedInstructionsNote('  End with BANANA.\n')).toBe(
      'Your team instructions have changed. The block below replaces the team instructions you were given earlier in this conversation, if any; follow it from now on:\n<team-instructions>\nEnd with BANANA.\n</team-instructions>',
    );
  });

  it('says the earlier ones no longer hold when the new ones are empty', () => {
    expect(changedInstructionsNote('   ')).toBe(
      'Your team instructions were removed: disregard the team instructions you were given earlier in this conversation.',
    );
  });
});

describe('readConversationInstructions', () => {
  it('reads each session key’s recorded hash', () => {
    const hash = teamInstructionsHashOf('May call: dev');
    expect(readConversationInstructions(JSON.stringify({ k: hash }))).toEqual({
      k: hash,
    });
  });

  it('reads an absent or unreadable column as nothing recorded', () => {
    expect(readConversationInstructions(null)).toEqual({});
    expect(readConversationInstructions('{not json')).toEqual({});
    expect(readConversationInstructions('{"k": 3}')).toEqual({});
  });
});

describe('teamInstructionsHashOf', () => {
  it('tells two texts apart and keeps one text stable', () => {
    expect(teamInstructionsHashOf('a')).toBe(teamInstructionsHashOf('a'));
    expect(teamInstructionsHashOf('a')).not.toBe(teamInstructionsHashOf('b'));
  });
});
