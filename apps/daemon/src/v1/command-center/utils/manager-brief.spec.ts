import { describe, expect, it } from 'vitest';

import {
  HOST_ARCHIVE_THREADS_TOOL,
  HOST_TELL_THREADS_TOOL,
} from '../../agents/chat.types';
import { composeManagerBrief, type RosterBriefLine } from './manager-brief';

const ROSTER: RosterBriefLine[] = [
  {
    handle: 't1',
    title: 'Billing  cache',
    project: 'Billing',
    reason: 'auto',
    note: 'waits for the schema to land',
    done: false,
  },
  {
    handle: 't2',
    title: 'Docs',
    project: null,
    reason: 'user',
    note: null,
    done: false,
  },
  {
    handle: 't3',
    title: 'Release',
    project: 'Web',
    reason: 'manager',
    note: 'owns the tag',
    done: true,
  },
];

describe('composeManagerBrief', () => {
  it('composes the same text for the same roster, byte for byte', () => {
    const again = structuredClone(ROSTER);

    expect(composeManagerBrief(again)).toBe(composeManagerBrief(ROSTER));
  });

  it('lists every handle with its title, project, why it is there, whether it is done and its note', () => {
    const brief = composeManagerBrief(ROSTER);

    expect(brief).toContain(
      '- t1 · Billing cache · Billing · active · note: waits for the schema to land',
    );
    expect(brief).toContain('- t2 · Docs · no project · added by the user');
    expect(brief).toContain(
      '- t3 · Release · Web · started by you · done · note: owns the tag',
    );
  });

  it('says no thread is active for an empty roster, and lists no handle', () => {
    const brief = composeManagerBrief([]);

    expect(brief).toContain('No threads are active right now.');
    expect(brief).not.toMatch(/^- t\d/m);
  });

  it('tells the manager to speak only when a thread is done or asks, never about statuses', () => {
    const brief = composeManagerBrief(ROSTER);

    expect(brief).toContain(
      'Write to the user only when a thread is done, when it asks something, or when a reply answers what the user asked.',
    );
    expect(brief).toContain("Never comment on a thread's status");
    expect(brief).not.toContain('you are told when it has started');
  });

  it('names the tool that reaches the threads by its wire name', () => {
    expect(composeManagerBrief(ROSTER)).toContain(
      `\`${HOST_TELL_THREADS_TOOL}\``,
    );
  });

  it('tells the manager to archive only on the user ask, by the tool wire name', () => {
    const brief = composeManagerBrief(ROSTER);

    expect(brief).toContain(
      `Archive threads with \`${HOST_ARCHIVE_THREADS_TOOL}\` only when the user asks you to in their own words`,
    );
  });

  it("closes with the user's standing instructions under their own heading", () => {
    const brief = composeManagerBrief(
      ROSTER,
      '  Answer in Russian.\nNever start threads on Fridays.  ',
    );

    expect(brief).toMatch(
      /## The user's standing instructions for you\n\nAnswer in Russian\.\nNever start threads on Fridays\.$/,
    );
  });

  it('adds no instructions section when the user has none', () => {
    expect(composeManagerBrief(ROSTER, '   ')).toBe(
      composeManagerBrief(ROSTER),
    );
    expect(composeManagerBrief(ROSTER)).not.toContain(
      "The user's standing instructions",
    );
  });
});
