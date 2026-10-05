import { describe, expect, it } from 'vitest';

import { isAgentToolName, toolKindOf, toolOperationOf } from './tool-kind';

describe('toolKindOf', () => {
  it('reads the kind the daemon stamped', () => {
    expect(toolKindOf({ name: 'Edit File', toolKind: 'edit' })).toBe('edit');
    expect(toolKindOf({ name: 'grep', toolKind: 'search' })).toBe('search');
  });

  it('is null for a call the CLI did not classify', () => {
    // Every claude row: the payload carries a name and an input and no kind, and
    // must keep going through the name buckets exactly as before.
    expect(toolKindOf({ name: 'Read', input: { file_path: '/a' } })).toBeNull();
    expect(toolKindOf(null)).toBeNull();
    expect(toolKindOf('edit')).toBeNull();
  });

  it('is null for a kind this summary has no phrase for', () => {
    // `think`/`switch_mode`/`other` are real ACP members with nothing to say
    // about them, and a later protocol version may add more. They read as
    // unclassified, which counts them as an unnamed call rather than inventing a
    // bucket — the honest answer for work the summary cannot describe.
    expect(toolKindOf({ toolKind: 'think' })).toBeNull();
    expect(toolKindOf({ toolKind: 'switch_mode' })).toBeNull();
    expect(toolKindOf({ toolKind: 'other' })).toBeNull();
    expect(toolKindOf({ toolKind: 'teleport' })).toBeNull();
  });
});

describe('toolOperationOf', () => {
  it('prefers the agent’s own classification over the tool name', () => {
    // Not a tie-break for tidiness: cursor titles a call "Edit File", which
    // matches no name bucket, and claude's `Read` carries no kind. Reading the
    // declared kind first is what lets ONE classifier serve both CLIs — which is
    // the whole reason this function exists rather than two tables.
    expect(toolOperationOf({ name: 'Edit File', toolKind: 'edit' })).toBe(
      'edit',
    );
    // And a declared kind wins even when the NAME says something else, because
    // the agent is the authority on its own call.
    expect(toolOperationOf({ name: 'Read', toolKind: 'execute' })).toBe(
      'execute',
    );
  });

  it('reads claude’s vocabulary when the agent declared nothing', () => {
    expect(toolOperationOf({ name: 'Bash' })).toBe('execute');
    expect(toolOperationOf({ name: 'Read' })).toBe('read');
    expect(toolOperationOf({ name: 'NotebookRead' })).toBe('read');
    expect(toolOperationOf({ name: 'Edit' })).toBe('edit');
    expect(toolOperationOf({ name: 'MultiEdit' })).toBe('edit');
    expect(toolOperationOf({ name: 'NotebookEdit' })).toBe('edit');
    expect(toolOperationOf({ name: 'Write' })).toBe('create');
    expect(toolOperationOf({ name: 'Grep' })).toBe('search');
    expect(toolOperationOf({ name: 'Glob' })).toBe('search');
    expect(toolOperationOf({ name: 'WebFetch' })).toBe('fetch');
    expect(toolOperationOf({ name: 'WebSearch' })).toBe('fetch');
    expect(toolOperationOf({ name: 'Task' })).toBe('delegate');
    expect(toolOperationOf({ name: 'mcp__linear__get_issue' })).toBe('mcp');
  });

  it('separates `create` from `edit`, which ACP does not', () => {
    // The protocol folds writing a new file into `edit`; claude has a distinct
    // `Write`, and the group summary has always counted "created" apart from
    // "edited". Collapse the two and that line silently loses a bucket.
    expect(toolOperationOf({ name: 'Write' })).toBe('create');
    expect(toolOperationOf({ name: 'Edit' })).toBe('edit');
  });

  it('checks the MCP prefix LAST', () => {
    // A server can expose a tool whose bare name matches a built-in bucket. The
    // specific match has to win, or `mcp__fs__Read`'s sibling patterns would
    // start reporting reads as generic MCP calls.
    expect(toolOperationOf({ name: 'mcp__fs__anything' })).toBe('mcp');
    expect(toolOperationOf({ name: 'Read' })).toBe('read');
  });

  it('answers null for anything it cannot classify, rather than guessing', () => {
    expect(toolOperationOf({ name: 'Telepathy' })).toBeNull();
    expect(toolOperationOf({ name: '' })).toBeNull();
    expect(toolOperationOf({})).toBeNull();
    expect(toolOperationOf(null)).toBeNull();
    expect(toolOperationOf('Read')).toBeNull();
    // An unspeakable ACP kind is unclassified too, the same reading `toolKindOf`
    // makes — so it lands on the status glyph instead of a guessed operation.
    expect(toolOperationOf({ name: 'x', toolKind: 'think' })).toBeNull();
  });

  it('says nothing about whether the call named a TARGET', () => {
    // The summary counts DISTINCT paths, so it needs its own "did this name a
    // file" test; folding that in here would make a call this cannot paint
    // indistinguishable from one it cannot classify at all.
    expect(toolOperationOf({ name: 'Read', input: {} })).toBe('read');
    expect(toolOperationOf({ name: 'Read', input: { file_path: '/a' } })).toBe(
      'read',
    );
  });

  it('recognises Task and Agent as delegations, and not SendMessage', () => {
    for (const name of ['Task', 'Agent']) {
      expect(isAgentToolName(name)).toBe(true);
      expect(toolOperationOf({ name })).toBe('delegate');
    }
    expect(isAgentToolName('SendMessage')).toBe(false);
  });

  it('matches a delegation name exactly, as the daemon’s run state does', () => {
    // Another CLI's command row titled `task` (go-task) is a command, and the
    // run state would not list it as a delegate either.
    expect(isAgentToolName('task')).toBe(false);
    expect(toolOperationOf({ name: 'task' })).not.toBe('delegate');
  });
});
