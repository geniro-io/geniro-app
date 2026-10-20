import { describe, expect, it } from 'vitest';

import {
  HOST_PUBLISH_ACTION_TOOL,
  HOST_REMOVE_ACTION_TOOL,
} from '../chat.types';
import { isHostActionCall } from './host-action';

const SERVER = 'geniro-1a2b3c4d';

describe('isHostActionCall', () => {
  it.each([HOST_PUBLISH_ACTION_TOOL, HOST_REMOVE_ACTION_TOOL])(
    "matches claude's and cursor's spellings of %s",
    (tool) => {
      expect(isHostActionCall(SERVER, `mcp__${SERVER}__${tool}`)).toBe(true);
      expect(isHostActionCall(SERVER, `${SERVER}-${tool}: ${tool}`)).toBe(true);
    },
  );

  it('refuses a same-named tool on somebody else’s server', () => {
    expect(isHostActionCall(SERVER, 'mcp__acme__publish_action')).toBe(false);
    expect(isHostActionCall(SERVER, 'acme-ops: remove_action')).toBe(false);
  });

  it('refuses another geniro tool', () => {
    expect(isHostActionCall(SERVER, `mcp__${SERVER}__show_chart`)).toBe(false);
  });
});
