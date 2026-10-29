import { describe, expect, it } from 'vitest';

import { codexPermissionHookOverrides } from './codex-hooks.utils';

const hook = (
  key: string,
  eventName: string,
  fields: { enabled?: boolean; isManaged?: boolean } = {},
) => ({ key, eventName, enabled: true, isManaged: false, ...fields });

const listed = (...entries: unknown[][]) => ({
  data: entries.map((hooks) => ({
    cwd: '/repo',
    errors: [],
    warnings: [],
    hooks,
  })),
});

describe('codexPermissionHookOverrides', () => {
  it('switches off every enabled permission-request hook of every folder, and nothing else', () => {
    expect(
      codexPermissionHookOverrides(
        listed(
          [
            hook(
              '/home/.codex/hooks.json:permission_request:0:0',
              'permissionRequest',
            ),
            hook('/home/.codex/hooks.json:pre_tool_use:0:0', 'preToolUse'),
            hook(
              '/home/.codex/hooks.json:permission_request:1:0',
              'permissionRequest',
              {
                enabled: false,
              },
            ),
          ],
          [
            hook(
              '/repo/.codex/hooks.json:permission_request:0:0',
              'permissionRequest',
            ),
          ],
        ),
      ),
    ).toEqual({
      'hooks.state': {
        '/home/.codex/hooks.json:permission_request:0:0': { enabled: false },
        '/repo/.codex/hooks.json:permission_request:0:0': { enabled: false },
      },
    });
  });

  it('leaves an administrator-managed permission-request hook on', () => {
    expect(
      codexPermissionHookOverrides(
        listed([
          hook(
            '/etc/codex/hooks.json:permission_request:0:0',
            'permissionRequest',
            {
              isManaged: true,
            },
          ),
        ]),
      ),
    ).toEqual({});
  });

  it('switches nothing off for a result it cannot read', () => {
    expect(codexPermissionHookOverrides(null)).toEqual({});
    expect(
      codexPermissionHookOverrides({
        data: [{ hooks: [{ eventName: 'permissionRequest', enabled: true }] }],
      }),
    ).toEqual({});
  });
});
