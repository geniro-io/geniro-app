import { describe, expect, it } from 'vitest';

import {
  claudePermissionOptions,
  claudeUpdatedPermissions,
} from './claude-permission-options.utils';

/**
 * `permission_suggestions` exactly as claude 2.1.295 sent them on a
 * `can_use_tool` for `touch probe-marker.txt` (see `claude.const.ts`).
 */
const SUGGESTIONS = [
  {
    type: 'addRules',
    rules: [{ toolName: 'Bash', ruleContent: 'touch probe-marker.txt' }],
    behavior: 'allow',
    destination: 'localSettings',
  },
  {
    type: 'addDirectories',
    directories: ['/repo'],
    destination: 'session',
  },
  { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
];

describe('claudePermissionOptions', () => {
  it('offers this session and always, each carrying the updates its allow sends', () => {
    expect(claudePermissionOptions(SUGGESTIONS)).toEqual([
      {
        id: 'session',
        label: 'Allow for this session',
        allow: true,
        scope: 'session',
        // Every destination rewritten, so nothing reaches a settings file.
        reply: [{ ...SUGGESTIONS[0], destination: 'session' }, SUGGESTIONS[1]],
      },
      {
        id: 'always',
        label: 'Always allow',
        allow: true,
        scope: 'always',
        reply: [SUGGESTIONS[0], SUGGESTIONS[1]],
      },
    ]);
  });

  it('never echoes a mode change — it is not an answer about this tool', () => {
    const replies = claudePermissionOptions(SUGGESTIONS).flatMap((option) =>
      Array.isArray(option.reply) ? option.reply : [],
    );
    expect(replies.some((update) => update.type === 'setMode')).toBe(false);
  });

  it('offers no "always" when every suggestion is session-scoped already', () => {
    expect(
      claudePermissionOptions([SUGGESTIONS[1], SUGGESTIONS[2]]).map(
        (option) => option.id,
      ),
    ).toEqual(['session']);
  });

  it('offers nothing for a request with no suggestion it can echo', () => {
    expect(claudePermissionOptions(undefined)).toEqual([]);
    expect(claudePermissionOptions([SUGGESTIONS[2], 'junk', null])).toEqual([]);
  });
});

describe('claudeUpdatedPermissions', () => {
  it("reads the picked option's updates, and none for a one-time answer", () => {
    const [session] = claudePermissionOptions(SUGGESTIONS);
    expect(claudeUpdatedPermissions(session)).toEqual(session?.reply);
    expect(claudeUpdatedPermissions(undefined)).toBeNull();
    expect(
      claudeUpdatedPermissions({
        id: 'x',
        label: 'x',
        allow: true,
        scope: 'session',
      }),
    ).toBeNull();
  });
});
