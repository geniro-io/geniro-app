import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { CodexItem } from '../codex.types';
import {
  codexApprovalCard,
  codexCardQuestions,
  encodeCodexReply,
  fileChangeStaysIn,
  withCodexAnswer,
} from './codex-approval.utils';
import { readCodexItem } from './codex-items.utils';

const QUESTIONS = {
  threadId: 't',
  turnId: 'u',
  itemId: 'call_q',
  isBlocking: true,
  questions: [
    {
      id: 'q1',
      header: 'Database',
      question: 'Which database should the service use?',
      isOther: true,
      isSecret: false,
      options: [
        { label: 'SQLite', description: 'embedded' },
        { label: 'Postgres', description: 'server' },
      ],
    },
  ],
};

const NO_ITEMS: ReadonlyMap<string, CodexItem> = new Map();

/** A session's open items, keyed the way `CodexSession.items` keys them. */
function itemsOf(...records: unknown[]): Map<string, CodexItem> {
  const items = new Map<string, CodexItem>();
  for (const record of records) {
    const item = readCodexItem(record)!;
    items.set(item.id, item);
  }
  return items;
}

const FILE_CHANGE = {
  type: 'fileChange',
  id: 'call_f',
  changes: [{ path: '/repo/a.ts', kind: { type: 'add' }, diff: 'x\n' }],
};

/** An MCP tool approval, as codex 0.157.1 sent it for a `show_metrics` call. */
const MCP_TOOL_APPROVAL = {
  threadId: 't',
  turnId: 'u',
  serverName: 'geniro-031a2e69',
  mode: 'form',
  message: 'Allow the geniro-031a2e69 MCP server to run tool "show_metrics"?',
  requestedSchema: { type: 'object', properties: {} },
  _meta: {
    codex_approval_kind: 'mcp_tool_call',
    persist: ['session', 'always'],
    tool_params: { title: 'Probe', metrics: [{ label: 'Tests', value: '43' }] },
  },
};

function mcpCall(id: string, tool: string, args: unknown): unknown {
  return {
    type: 'mcpToolCall',
    id,
    server: 'geniro-031a2e69',
    tool,
    status: 'inProgress',
    arguments: args,
  };
}

describe('codexApprovalCard', () => {
  it('shows a command request as the command it would run', () => {
    expect(
      codexApprovalCard(
        'item/commandExecution/requestApproval',
        {
          itemId: 'c',
          command: 'npm install',
          cwd: '/repo',
          reason: 'needs network',
        },
        NO_ITEMS,
      ),
    ).toEqual({
      toolName: 'shell',
      input: { command: 'npm install', cwd: '/repo', reason: 'needs network' },
      question: false,
    });
  });

  it('shows input for a running command as input, not as a new command', () => {
    expect(
      codexApprovalCard(
        'item/commandExecution/requestApproval',
        { itemId: 'c', kind: 'writeStdin', command: 'y\n', cwd: '/repo' },
        NO_ITEMS,
      )?.toolName,
    ).toBe('write_stdin');
  });

  it('names the host a network approval would reach', () => {
    expect(
      codexApprovalCard(
        'item/commandExecution/requestApproval',
        {
          itemId: 'c',
          command: 'curl example.com',
          cwd: '/repo',
          networkApprovalContext: { host: 'example.com', protocol: 'https' },
        },
        NO_ITEMS,
      )?.input,
    ).toEqual({
      command: 'curl example.com',
      cwd: '/repo',
      network: { host: 'example.com', protocol: 'https' },
    });
  });

  it('shows a file-change request with the changes its item announced', () => {
    const card = codexApprovalCard(
      'item/fileChange/requestApproval',
      { itemId: 'call_f' },
      itemsOf(FILE_CHANGE),
    );
    expect(card?.input).toEqual({
      diffs: [{ path: '/repo/a.ts', oldText: null, newText: 'x\n' }],
    });
  });

  it('shows the extra write root a file-change request asks for', () => {
    expect(
      codexApprovalCard(
        'item/fileChange/requestApproval',
        { itemId: 'call_f', grantRoot: '/etc' },
        itemsOf(FILE_CHANGE),
      )?.input,
    ).toEqual({
      diffs: [{ path: '/repo/a.ts', oldText: null, newText: 'x\n' }],
      grantRoot: '/etc',
    });
  });

  it('shows a question request as a question card', () => {
    expect(
      codexApprovalCard('item/tool/requestUserInput', QUESTIONS, NO_ITEMS),
    ).toEqual({
      toolName: 'request_user_input',
      input: QUESTIONS,
      question: true,
      questions: codexCardQuestions(QUESTIONS),
    });
  });

  it('names an MCP tool approval after the call it approves', () => {
    const items = itemsOf(
      mcpCall('exec-1', 'show_metrics', MCP_TOOL_APPROVAL._meta.tool_params),
    );
    expect(
      codexApprovalCard(
        'mcpServer/elicitation/request',
        MCP_TOOL_APPROVAL,
        items,
      ),
    ).toEqual({
      toolName: 'mcp__geniro-031a2e69__show_metrics',
      input: MCP_TOOL_APPROVAL._meta.tool_params,
      question: false,
    });
  });

  it('picks the open call whose arguments the approval carries', () => {
    const items = itemsOf(
      mcpCall('exec-1', 'show_metrics', MCP_TOOL_APPROVAL._meta.tool_params),
      mcpCall('exec-2', 'show_chart', { title: 'Other' }),
    );
    expect(
      codexApprovalCard(
        'mcpServer/elicitation/request',
        MCP_TOOL_APPROVAL,
        items,
      )?.toolName,
    ).toBe('mcp__geniro-031a2e69__show_metrics');
  });

  it('keeps the bare server name, and codex’s own sentence, when the call cannot be found', () => {
    expect(
      codexApprovalCard(
        'mcpServer/elicitation/request',
        MCP_TOOL_APPROVAL,
        NO_ITEMS,
      ),
    ).toEqual({
      toolName: 'mcp__geniro-031a2e69',
      input: {
        message: MCP_TOOL_APPROVAL.message,
        arguments: MCP_TOOL_APPROVAL._meta.tool_params,
      },
      question: false,
    });
  });

  it('names no tool when two running calls carry the same arguments', () => {
    // Either could be the one asking; a card naming the wrong one has the
    // user approve a different tool.
    const args = MCP_TOOL_APPROVAL._meta.tool_params;
    const items = itemsOf(
      mcpCall('exec-1', 'show_metrics', args),
      mcpCall('exec-2', 'show_chart', args),
    );
    expect(
      codexApprovalCard(
        'mcpServer/elicitation/request',
        MCP_TOOL_APPROVAL,
        items,
      )?.toolName,
    ).toBe('mcp__geniro-031a2e69');
  });

  it('names no tool when several calls run and none carries the approval’s arguments', () => {
    const items = itemsOf(
      mcpCall('exec-1', 'show_metrics', { other: 1 }),
      mcpCall('exec-2', 'show_chart', { other: 2 }),
    );
    expect(
      codexApprovalCard(
        'mcpServer/elicitation/request',
        MCP_TOOL_APPROVAL,
        items,
      ),
    ).toMatchObject({
      toolName: 'mcp__geniro-031a2e69',
      input: { message: MCP_TOOL_APPROVAL.message },
    });
  });

  it('names the only call running on the server even when its arguments read differently', () => {
    const items = itemsOf(mcpCall('exec-1', 'show_metrics', { other: true }));
    expect(
      codexApprovalCard(
        'mcpServer/elicitation/request',
        MCP_TOOL_APPROVAL,
        items,
      )?.toolName,
    ).toBe('mcp__geniro-031a2e69__show_metrics');
  });

  it('shows no card for an elicitation that is not a tool approval', () => {
    expect(
      codexApprovalCard(
        'mcpServer/elicitation/request',
        {
          serverName: 'github',
          mode: 'form',
          message: 'Which repository?',
          requestedSchema: { type: 'object', properties: {} },
          _meta: null,
        },
        NO_ITEMS,
      ),
    ).toBeNull();
  });

  it('shows no card for a request it does not handle', () => {
    expect(
      codexApprovalCard('item/tool/call', { tool: 'x' }, NO_ITEMS),
    ).toBeNull();
    expect(
      codexApprovalCard(
        'item/tool/requestUserInput',
        { questions: [] },
        NO_ITEMS,
      ),
    ).toBeNull();
  });
});

describe('fileChangeStaysIn', () => {
  it('holds for a change inside the turn folder', () => {
    expect(
      fileChangeStaysIn({ itemId: 'call_f' }, itemsOf(FILE_CHANGE), '/repo'),
    ).toBe(true);
  });

  it('reads a relative path against the turn folder', () => {
    const items = itemsOf({
      ...FILE_CHANGE,
      changes: [{ path: 'src/a.ts', kind: { type: 'add' }, diff: 'x\n' }],
    });
    expect(fileChangeStaysIn({ itemId: 'call_f' }, items, '/repo')).toBe(true);
  });

  it('fails for a request that asks for another write root', () => {
    expect(
      fileChangeStaysIn(
        { itemId: 'call_f', grantRoot: '/etc' },
        itemsOf(FILE_CHANGE),
        '/repo',
      ),
    ).toBe(false);
  });

  it('fails when any changed path leaves the turn folder', () => {
    const items = itemsOf({
      ...FILE_CHANGE,
      changes: [
        { path: '/repo/a.ts', kind: { type: 'add' }, diff: 'x\n' },
        { path: '/repo/../etc/hosts', kind: { type: 'update' }, diff: 'y\n' },
      ],
    });
    expect(fileChangeStaysIn({ itemId: 'call_f' }, items, '/repo')).toBe(false);
  });

  it('fails when the changes cannot be seen', () => {
    expect(fileChangeStaysIn({ itemId: 'call_f' }, NO_ITEMS, '/repo')).toBe(
      false,
    );
  });

  it('fails for a change that names no path, even beside one that does', () => {
    // Dropping the unknown target and judging the rest would accept a write
    // nobody can see.
    const items = itemsOf({
      ...FILE_CHANGE,
      changes: [
        { path: '/repo/a.ts', kind: { type: 'add' }, diff: 'x\n' },
        { kind: { type: 'update', move_path: null }, diff: 'x\n' },
      ],
    });
    expect(fileChangeStaysIn({ itemId: 'call_f' }, items, '/repo')).toBe(false);
  });

  it('fails when a move takes a file out of the folder', () => {
    const items = itemsOf({
      ...FILE_CHANGE,
      changes: [
        {
          path: '/repo/notes.md',
          kind: { type: 'update', move_path: '/Users/me/.zshrc' },
          diff: '',
        },
      ],
    });
    expect(fileChangeStaysIn({ itemId: 'call_f' }, items, '/repo')).toBe(false);
  });

  it('holds for a move that stays inside the folder', () => {
    const items = itemsOf({
      ...FILE_CHANGE,
      changes: [
        {
          path: '/repo/notes.md',
          kind: { type: 'update', move_path: '/repo/docs/notes.md' },
          diff: '',
        },
      ],
    });
    expect(fileChangeStaysIn({ itemId: 'call_f' }, items, '/repo')).toBe(true);
  });

  it('fails for a path that leaves the folder through a symlink inside it', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-stays-in-'));
    const outside = mkdtempSync(join(tmpdir(), 'codex-outside-'));
    try {
      symlinkSync(outside, join(root, 'docs'));
      mkdirSync(join(root, 'src'));
      const change = (path: string) =>
        itemsOf({
          ...FILE_CHANGE,
          changes: [{ path, kind: { type: 'add' }, diff: 'x\n' }],
        });
      expect(
        fileChangeStaysIn(
          { itemId: 'call_f' },
          change(join(root, 'docs', 'authorized_keys')),
          root,
        ),
      ).toBe(false);
      // The same folder's ordinary directory is fine — the link is the escape.
      expect(
        fileChangeStaysIn(
          { itemId: 'call_f' },
          change(join(root, 'src', 'a.ts')),
          root,
        ),
      ).toBe(true);
      // A move whose DESTINATION is a link out is judged the same way.
      symlinkSync(join(outside, 'zshrc'), join(root, 'dotfile'));
      expect(
        fileChangeStaysIn(
          { itemId: 'call_f' },
          itemsOf({
            ...FILE_CHANGE,
            changes: [
              {
                path: join(root, 'src', 'a.ts'),
                kind: { type: 'update', move_path: join(root, 'dotfile') },
                diff: '',
              },
            ],
          }),
          root,
        ),
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('fails for a change to a file that shares its contents with another name', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-stays-in-'));
    const outside = mkdtempSync(join(tmpdir(), 'codex-outside-'));
    try {
      writeFileSync(join(outside, 'secret.txt'), 'x');
      linkSync(join(outside, 'secret.txt'), join(root, 'shared.txt'));
      writeFileSync(join(root, 'plain.txt'), 'y');
      const change = (path: string) =>
        itemsOf({
          ...FILE_CHANGE,
          changes: [{ path, kind: { type: 'update' }, diff: 'x\n' }],
        });
      // Writing `shared.txt` writes the file outside the folder as well.
      expect(
        fileChangeStaysIn(
          { itemId: 'call_f' },
          change(join(root, 'shared.txt')),
          root,
        ),
      ).toBe(false);
      // codex may name the file relative to the turn's folder.
      expect(
        fileChangeStaysIn({ itemId: 'call_f' }, change('shared.txt'), root),
      ).toBe(false);
      // A file nothing else names, and one that does not exist yet, are fine.
      expect(
        fileChangeStaysIn(
          { itemId: 'call_f' },
          change(join(root, 'plain.txt')),
          root,
        ),
      ).toBe(true);
      expect(
        fileChangeStaysIn(
          { itemId: 'call_f' },
          change(join(root, 'new.txt')),
          root,
        ),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it.each(['link/../x', 'link/../newdir/../x'])(
    'fails for a change whose `%s` names, as written, a file another name shares',
    (path) => {
      // `link` stays inside the folder, so containment holds either way; the
      // file that path names as written is shared, and the folder's own `x` is
      // not there. (`write-containment.spec.ts` holds the collapsed reading.)
      const root = mkdtempSync(join(tmpdir(), 'codex-stays-in-'));
      const outside = mkdtempSync(join(tmpdir(), 'codex-outside-'));
      try {
        mkdirSync(join(root, 'a', 'b'), { recursive: true });
        symlinkSync(join(root, 'a', 'b'), join(root, 'link'));
        writeFileSync(join(outside, 'secret.txt'), 'x');
        linkSync(join(outside, 'secret.txt'), join(root, 'a', 'x'));
        const items = itemsOf({
          ...FILE_CHANGE,
          changes: [{ path, kind: { type: 'update' }, diff: 'x\n' }],
        });
        expect(fileChangeStaysIn({ itemId: 'call_f' }, items, root)).toBe(
          false,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    },
  );

  it('judges codex’s RAW path, so a `link/..` it names is a card', () => {
    // Collapsing the `..` first would read this as `<root>/x.txt`, inside.
    const root = mkdtempSync(join(tmpdir(), 'codex-stays-in-'));
    const outside = mkdtempSync(join(tmpdir(), 'codex-outside-'));
    try {
      mkdirSync(join(outside, 'deeper'));
      symlinkSync(join(outside, 'deeper'), join(root, 'dirlink'));
      const items = itemsOf({
        ...FILE_CHANGE,
        changes: [
          { path: `${root}/dirlink/../x.txt`, kind: { type: 'add' }, diff: '' },
        ],
      });
      expect(fileChangeStaysIn({ itemId: 'call_f' }, items, root)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('questions', () => {
  it('projects the question card, descriptions included', () => {
    expect(codexCardQuestions(QUESTIONS)).toEqual([
      {
        question: 'Which database should the service use?',
        header: 'Database',
        multiSelect: false,
        options: [
          { label: 'SQLite', description: 'embedded', preview: null },
          { label: 'Postgres', description: 'server', preview: null },
        ],
      },
    ]);
  });

  it('marks a question codex flags `isSecret`, and no other', () => {
    // A secret question's card masks the field and keeps the answer out of
    // the transcript; every ordinary one keeps the shape it always had.
    const cards = codexCardQuestions({
      questions: [
        { ...QUESTIONS.questions[0], id: 'q1', isSecret: false },
        {
          id: 'q2',
          header: 'Token',
          question: 'Paste the deploy token',
          isOther: true,
          isSecret: true,
          options: null,
        },
      ],
    });

    expect(cards.map((card) => card.secret)).toEqual([undefined, true]);
  });

  it('leaves a question with no id off the card — nothing could answer it', () => {
    const params = { questions: [{ question: 'Which?', options: [] }] };
    expect(codexCardQuestions(params)).toEqual([]);
    expect(
      codexApprovalCard('item/tool/requestUserInput', params, new Map()),
    ).toBe(null);
  });
});

describe('encodeCodexReply', () => {
  it('accepts and declines an approval by decision', () => {
    expect(
      encodeCodexReply('item/commandExecution/requestApproval', {}, true, {}),
    ).toEqual({ decision: 'accept' });
    // `decline`, not `cancel`: cancel would also end the turn.
    expect(
      encodeCodexReply('item/fileChange/requestApproval', {}, false, {}),
    ).toEqual({ decision: 'decline' });
  });

  it('accepts an MCP tool approval with an empty form, and declines it', () => {
    expect(
      encodeCodexReply(
        'mcpServer/elicitation/request',
        MCP_TOOL_APPROVAL,
        true,
        MCP_TOOL_APPROVAL,
      ),
    ).toEqual({ action: 'accept', content: {}, _meta: null });
    expect(
      encodeCodexReply(
        'mcpServer/elicitation/request',
        MCP_TOOL_APPROVAL,
        false,
        MCP_TOOL_APPROVAL,
      ),
    ).toEqual({ action: 'decline', content: null, _meta: null });
  });

  it('answers a question with the card’s free text', () => {
    const answered = withCodexAnswer(QUESTIONS, 'Postgres');
    expect(
      encodeCodexReply('item/tool/requestUserInput', QUESTIONS, true, answered),
    ).toEqual({ answers: { q1: { answers: ['Postgres'] } } });
  });

  it('answers every question the card showed, keyed by its id, and no other', () => {
    // A question with no text never reached the card, so the user answered
    // nothing about it.
    const params = {
      questions: [
        { id: 'q1', question: 'Which region?', options: [] },
        { id: 'q2', question: 'Which size?', options: [] },
        { id: 'q3', options: [] },
      ],
    };
    expect(
      encodeCodexReply(
        'item/tool/requestUserInput',
        params,
        true,
        withCodexAnswer(params, 'eu, small'),
      ),
    ).toEqual({
      answers: {
        q1: { answers: ['eu, small'] },
        q2: { answers: ['eu, small'] },
      },
    });
  });

  it('sends each question its own line, so a secret reaches its own slot and no other', () => {
    // The card submits one labelled entry per question, and each slot is sent
    // its own — the region's answer must not carry the token.
    const params = {
      questions: [
        { id: 'region', question: 'Which region?', options: [] },
        { id: 'token', question: 'Your token?', isSecret: true, options: [] },
      ],
    };
    expect(
      encodeCodexReply(
        'item/tool/requestUserInput',
        params,
        true,
        withCodexAnswer(params, 'Which region?: eu\nYour token?: ghp_abc123'),
      ),
    ).toEqual({
      answers: {
        region: { answers: ['eu'] },
        token: { answers: ['ghp_abc123'] },
      },
    });
  });

  it('sends an entry it cannot find no answer when the card asks for a secret', () => {
    // Elsewhere the whole reply stands in for a missing entry; here it would
    // carry the secret into a slot that is not the secret's.
    const params = {
      questions: [
        { id: 'region', question: 'Which region?', options: [] },
        { id: 'token', question: 'Your token?', isSecret: true, options: [] },
      ],
    };
    expect(
      encodeCodexReply(
        'item/tool/requestUserInput',
        params,
        true,
        withCodexAnswer(params, 'eu ghp_abc123'),
      ),
    ).toEqual({
      answers: { region: { answers: [] }, token: { answers: [] } },
    });
  });

  it('sends no answers when the user declines a question', () => {
    expect(
      encodeCodexReply(
        'item/tool/requestUserInput',
        QUESTIONS,
        false,
        QUESTIONS,
      ),
    ).toEqual({ answers: {} });
  });

  it('grants the permissions asked for, or none', () => {
    const params = { permissions: { network: { enabled: true } } };
    expect(
      encodeCodexReply(
        'item/permissions/requestApproval',
        params,
        true,
        params,
      ),
    ).toEqual({ permissions: { network: { enabled: true } }, scope: 'turn' });
    expect(
      encodeCodexReply(
        'item/permissions/requestApproval',
        params,
        false,
        params,
      ),
    ).toEqual({ permissions: {}, scope: 'turn' });
  });
});
