import { describe, expect, it } from 'vitest';

import {
  geniroCardKindOf,
  isGeniroCardKind,
  isGeniroToolName,
} from './geniro-tool';

const RUN = 'abc12345-0000-0000-0000-000000000000';
const SERVER = 'geniro-abc12345';

describe('geniro’s own tool calls', () => {
  it('recognises the per-run server name', () => {
    expect(isGeniroToolName(`mcp__${SERVER}__show_artifact`, RUN)).toBe(true);
  });

  it('recognises the LEGACY fixed key, for transcripts stored before the rename', () => {
    // claude published under this key before the per-run rename; without it an
    // old conversation starts showing raw envelope rows on replay.
    expect(isGeniroToolName('mcp__geniro__report_findings', RUN)).toBe(true);
  });

  it('recognises cursor’s prose label, which carries no mcp__ name at all', () => {
    expect(isGeniroToolName(`Geniro ${SERVER}: show_chart`, RUN)).toBe(true);
  });

  it('refuses a user’s OWN server that happens to be called geniro', () => {
    // Matching the prefix alone hid every call to their server too, so an agent
    // would work through it while the transcript showed nothing.
    expect(isGeniroToolName('mcp__geniro-mine__show_artifact', RUN)).toBe(
      false,
    );
    expect(isGeniroToolName('mcp__geniro__deploy', RUN)).toBe(false);
  });

  it('refuses another RUN’s server, which is what makes the name unforgeable', () => {
    expect(
      isGeniroToolName(`mcp__${SERVER}__show_artifact`, 'ffffffff-0000'),
    ).toBe(false);
  });
});

describe('which of them draw a card', () => {
  it('names the card each drawing tool is about to produce', () => {
    expect(geniroCardKindOf(`mcp__${SERVER}__show_artifact`, RUN)).toBe(
      'artifact',
    );
    expect(geniroCardKindOf(`mcp__${SERVER}__show_chart`, RUN)).toBe('chart');
    expect(geniroCardKindOf(`mcp__${SERVER}__propose_plan`, RUN)).toBe('plan');
  });

  it('answers null for one of geniro’s tools that draws NOTHING', () => {
    // A call tool's story is told by the dedicated call rows, so there is no
    // card coming and a placeholder would resolve into nothing at all.
    expect(geniroCardKindOf(`mcp__${SERVER}__call_agent`, RUN)).toBeNull();
    expect(
      geniroCardKindOf(`mcp__${SERVER}__ask_user_question`, RUN),
    ).toBeNull();
  });

  it('answers null for a tool that is not geniro’s', () => {
    expect(geniroCardKindOf('Bash', RUN)).toBeNull();
    expect(geniroCardKindOf('mcp__linear__create_issue', RUN)).toBeNull();
  });

  it('guards a kind read off an untyped payload', () => {
    // The row's renderer reads this off `payload`, which is `unknown` by the
    // same rule every item's is.
    expect(isGeniroCardKind('artifact')).toBe(true);
    expect(isGeniroCardKind('call_agent')).toBe(false);
    expect(isGeniroCardKind(null)).toBe(false);
  });
});
