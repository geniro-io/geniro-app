import { describe, expect, it } from 'vitest';

import {
  HOST_BACKUP_TEAM_TOOL,
  HOST_PROPOSE_TEAM_TOOL,
  HOST_READ_TEAMS_TOOL,
  HOST_TEAM_CHANGE_TOOL,
} from '../chat.types';
import {
  isHostBuilderTeamCall,
  isHostTeamProposalCall,
  teamVerdictMessage,
} from './host-teams';

const SERVER = 'geniro-1a2b3c4d';

describe('team host-tool predicates', () => {
  it("matches claude's and cursor's spellings of propose_team, and only it", () => {
    const read = `${SERVER}-${HOST_READ_TEAMS_TOOL}: ${HOST_READ_TEAMS_TOOL}`;

    expect(
      isHostTeamProposalCall(
        SERVER,
        `mcp__${SERVER}__${HOST_PROPOSE_TEAM_TOOL}`,
      ),
    ).toBe(true);
    expect(
      isHostTeamProposalCall(
        SERVER,
        `${SERVER}-${HOST_PROPOSE_TEAM_TOOL}: ${HOST_PROPOSE_TEAM_TOOL}`,
      ),
    ).toBe(true);
    expect(isHostTeamProposalCall(SERVER, read)).toBe(false);
  });

  it('refuse a same-named tool on somebody else’s server', () => {
    expect(isHostTeamProposalCall(SERVER, 'mcp__acme__propose_team')).toBe(
      false,
    );
  });
});

describe('isHostBuilderTeamCall', () => {
  const call = (tool: string) => `mcp__${SERVER}__${tool}`;

  it('passes the read, the backup and the check, which write no change', () => {
    for (const tool of [
      HOST_READ_TEAMS_TOOL,
      HOST_BACKUP_TEAM_TOOL,
      HOST_TEAM_CHANGE_TOOL,
    ]) {
      expect(isHostBuilderTeamCall(SERVER, call(tool))).toBe(true);
    }
    // The proposal passes on its own predicate, for every chat.
    expect(isHostBuilderTeamCall(SERVER, call(HOST_PROPOSE_TEAM_TOOL))).toBe(
      false,
    );
    expect(
      isHostBuilderTeamCall(SERVER, `mcp__acme__${HOST_TEAM_CHANGE_TOOL}`),
    ).toBe(false);
  });
});

describe('teamVerdictMessage', () => {
  it('names the saved slug and the backup of a replaced file', () => {
    expect(
      teamVerdictMessage({
        kind: 'saved',
        slug: 'team',
        backup: '.backups/team.2026-10-20T10-00-00.yaml',
        note: null,
      }),
    ).toBe(
      "(Approved — saved as 'team' in the team library. The previous version is backed up as .backups/team.2026-10-20T10-00-00.yaml.)",
    );
  });

  it('quotes the note typed on Approve, and on a write that did not happen', () => {
    expect(
      teamVerdictMessage({
        kind: 'saved',
        slug: 'team',
        backup: null,
        note: 'rename the reviewer',
      }),
    ).toBe(
      "(Approved — saved as 'team' in the team library. The user's note: rename the reviewer)",
    );
    expect(
      teamVerdictMessage({
        kind: 'not-saved',
        cause: 'write-failed',
        reason: 'the file could not be written',
        note: 'go',
      }),
    ).toBe(
      "(Not saved — the file could not be written. Read the library again with read_teams before proposing again. The user's note: go)",
    );
  });

  it('quotes a decline note, and says when there was none', () => {
    expect(
      teamVerdictMessage({ kind: 'declined', note: '  too many agents ' }),
    ).toBe("(Declined — nothing was saved. The user's note: too many agents)");
    expect(teamVerdictMessage({ kind: 'declined', note: '   ' })).toBe(
      '(Declined — the user gave no reason. Nothing was saved.)',
    );
  });
});
