import {
  CHAT_APPROVAL_MODES,
  type ChatApprovalMode,
  type HostBoardTool,
} from '../../agents/chat.types';
import type { TaskBoardTool } from '../../graphs/graphs.types';
import { AgentKind } from '../../runs/runs.types';
import {
  AUTOPILOT_PICKUP_SECONDS,
  BOARD_LIST_TASKS_DEFAULT_LIMIT,
  BOARD_LIST_TASKS_MAX_LIMIT,
  TASK_AGENT_OWN_STATUSES,
  TASK_DESCRIPTION_MAX,
  TASK_LABEL_MAX,
  TASK_LABELS_MAX,
  TASK_PRIORITIES,
  TASK_REPORT_MAX,
  TASK_RUN_CONFIG_FIELDS,
  TASK_SOURCE_REF_MAX,
  TASK_STATUSES,
  TASK_TITLE_MAX,
  type TaskPriority,
  type TaskStatus,
} from '../tasks.types';

/**
 * The board tools as an agent that has never seen this repository reads them.
 *
 * The listing is the whole manual: every argument says what it means, its
 * format, its bounds and its default, every enum is spelled with what each
 * value means, and every value that belongs to the MACHINE rather than to the
 * schema (labels in use, CLIs, models, workflows) names the tool that lists it.
 * The descriptions join the audited set in `mcp-server.service.spec.ts`.
 */

/** What each column means — the sentence an agent picks a column by. */
export const TASK_STATUS_MEANINGS: Readonly<Record<TaskStatus, string>> = {
  backlog:
    'parked — noted but not queued (the default for a new card); nothing starts work on it unless a project’s autopilot takes work from `backlog`, which list_projects would show',
  todo: 'queued and ready to be worked — on most boards the autopilot intake, where an ARMED project starts an agent on it by itself',
  in_progress: 'being worked right now, normally by an agent run started on it',
  in_review: 'the work is done and waits for a person to review it',
  done: 'finished — nothing is left to review',
  failed:
    'could not be done (the report says why); the autopilot also parks a card here after repeated failed runs',
};

export const TASK_PRIORITY_MEANINGS: Readonly<Record<TaskPriority, string>> = {
  none: 'not triaged yet (the default)',
  urgent: 'drop everything',
  high: 'next up',
  medium: 'normal',
  low: 'whenever there is time',
};

export const APPROVAL_MODE_MEANINGS: Readonly<
  Record<ChatApprovalMode, string>
> = {
  auto: 'the agent runs every tool without asking (what an unattended autopilot run always uses)',
  ask: 'the agent asks the user before each tool that needs permission',
  acceptEdits:
    'file edits inside the folder are approved, every other permission asks (not every CLI offers it — board_vocabulary lists each CLI’s modes)',
  plan: 'read-only: the agent plans and changes nothing',
};

const enumList = <T extends string>(meanings: Readonly<Record<T, string>>) =>
  Object.entries(meanings)
    .map(([value, meaning]) => `\`${value}\` = ${meaning as string}`)
    .join('; ');

const AGENT_KINDS = Object.values(AgentKind);

const AUTOPILOT_HAZARD =
  `AUTOPILOT: a project whose autopilot is ARMED starts an agent, by itself and within about ${AUTOPILOT_PICKUP_SECONDS} seconds, on ` +
  'any card that lands in its intake column (usually `todo`; list_projects says which projects are armed and which ' +
  'column each takes work from). So put a card in the intake column of an armed project ONLY when you mean an agent ' +
  'to start on it now — otherwise use `backlog` (or `todo` where `backlog` itself is the armed intake). A conversation ' +
  'not running in `auto` approval is refused: on a board whose autopilot is ARMED, putting a card in its intake ' +
  'or changing any existing card (only the run working a card may still report it and move it to a non-intake ' +
  'column); and on any board, setting a card’s approval to `auto` or changing an EXISTING card’s run configuration (' +
  TASK_RUN_CONFIG_FIELDS.join(', ') +
  ') — file in a quiet column and tell the user what to change instead. ' +
  'The answer says when a card landed in an armed intake.';

/**
 * Said by both writers: their names sit beside the CLIs' own checklist tools
 * (claude's TaskCreate/TaskUpdate, a todo tool), and the two are easy to swap.
 */
const NOT_A_CHECKLIST =
  'These cards are the user’s shared project board, shown in the app — NOT your own working checklist (TaskCreate, ' +
  'TodoWrite or a todo list): never use these tools to track your own steps.';

const PROJECT_ARG = {
  type: 'string',
  description:
    'The project — its id, its card key (e.g. "GEN", case-insensitive) or its exact name. list_projects lists them.',
};

const TASK_REF_ARG = {
  type: 'string',
  description:
    'The card — its key (e.g. "GEN-53", case-insensitive) or its id. list_tasks finds keys.',
};

const STATUS_ARG = {
  type: 'string',
  enum: [...TASK_STATUSES],
  description: `The board column. ${enumList(TASK_STATUS_MEANINGS)}.`,
};

const PRIORITY_ARG = {
  type: 'string',
  enum: [...TASK_PRIORITIES],
  description: `How urgent the card is. ${enumList(TASK_PRIORITY_MEANINGS)}.`,
};

/**
 * The card's own fields both writers take. `nullable` is the update form:
 * there `null` clears a field (and hands a run-configuration field back to the
 * project), where create simply omits it.
 */
function cardFieldArgs(nullable: boolean): Record<string, unknown> {
  const clear = (what: string) =>
    nullable ? ` Pass null to ${what}; omit to leave it as it is.` : '';
  const type = (base: string) => (nullable ? [base, 'null'] : base);
  const inherit = (field: string) =>
    nullable
      ? ` Pass null to inherit the project's ${field} again; omit to leave it as it is.`
      : ` Omit to inherit the project's ${field} (list_projects shows it) — the usual choice.`;
  return {
    title: {
      type: 'string',
      description: `One line naming the work, 1–${TASK_TITLE_MAX} characters after trimming.${nullable ? ' Omit to leave it as it is.' : ''}`,
    },
    description: {
      type: type('string'),
      description:
        `The brief, as markdown, at most ${TASK_DESCRIPTION_MAX} characters — what the agent or person working ` +
        'the card is given, so write everything needed to do it without asking: the problem, the goal, ' +
        'constraints, and how to verify.' +
        (nullable
          ? ' Pass null to clear it; omit to leave it as it is.'
          : ' Optional.'),
    },
    priority: {
      ...PRIORITY_ARG,
      description: `${PRIORITY_ARG.description}${nullable ? ' Omit to leave it as it is.' : ' Default `none`.'}`,
    },
    labels: {
      type: 'array',
      items: { type: 'string' },
      maxItems: TASK_LABELS_MAX,
      description:
        `Labels, at most ${TASK_LABELS_MAX}, each 1–${TASK_LABEL_MAX} characters with no control characters. ` +
        'Any text is accepted — a new label is created by using it — but prefer the ones already on the board ' +
        '(board_vocabulary lists them): a label can carry INSTRUCTIONS that every agent run on the card receives.' +
        (nullable
          ? ' REPLACES the whole list — send every label the card should keep; [] removes them all; omit to leave them.'
          : ' Default none.'),
    },
    dueDate: {
      type: type('string'),
      description: `The day it is due, as a calendar date YYYY-MM-DD (no time, no zone).${clear('clear it')}${nullable ? '' : ' Optional.'}`,
    },
    folder: {
      type: type('string'),
      description:
        "An absolute path to an EXISTING directory the card's agent works in (a git repository; the agent works " +
        `in a fresh worktree cut from it).${inherit('folder')}`,
    },
    agentKind: {
      type: type('string'),
      enum: nullable ? [...AGENT_KINDS, null] : [...AGENT_KINDS],
      description:
        `Which CLI agent runs the card: ${AGENT_KINDS.map((kind) => `\`${kind}\``).join(', ')} ` +
        '(board_vocabulary says which are installed).' +
        inherit('agent'),
    },
    model: {
      type: type('string'),
      description:
        "The model id, exactly as that CLI spells it — board_vocabulary with `agentKind` lists them. Inherits only while the card's agent is the project's agent." +
        inherit('model'),
    },
    effort: {
      type: type('string'),
      description:
        'The reasoning-effort level id for that CLI and model — board_vocabulary with `agentKind` lists them.' +
        inherit('effort'),
    },
    approval: {
      type: type('string'),
      enum: nullable
        ? [...CHAT_APPROVAL_MODES, null]
        : [...CHAT_APPROVAL_MODES],
      description: `How the card's agent asks for permission. ${enumList(APPROVAL_MODE_MEANINGS)}. A conversation not itself running in \`auto\` approval cannot set \`auto\` here.${inherit('approval mode')}`,
    },
    configDir: {
      type: type('string'),
      description:
        "An absolute path to an EXISTING agent config directory (a CLI profile — another account's login, settings " +
        'and plugins). Directories already used on the board are listed by board_vocabulary.' +
        inherit('config directory'),
    },
    workflowSlug: {
      type: type('string'),
      description:
        'Run the card through this saved WORKFLOW (a team of agents) instead of a single agent — its library slug, ' +
        'listed by board_vocabulary. The card decides over the project: whichever of the two is more specific and ' +
        'names an agent or a workflow is what runs, and on one level a workflow wins over an agent.' +
        inherit('workflow'),
    },
  };
}

const TOOLS: Readonly<Record<HostBoardTool, TaskBoardTool>> = {
  list_projects: {
    name: 'list_projects',
    description:
      'List the projects on the task board — a project is a board of cards for one repository folder. For each: ' +
      'its id, name, card key (cards are numbered `<KEY>-<n>`, e.g. GEN-53), folder, the run configuration its ' +
      'cards inherit (agent, model, effort, approval mode, config directory, workflow — null means not set), its ' +
      'autopilot (whether it is ARMED and which column it takes work from), and how many cards each column holds. ' +
      'Use it when you need a project id or key, before creating a card, or to check whether a column is an armed ' +
      'intake. Do not use it to read cards — list_tasks does that.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  board_vocabulary: {
    name: 'board_vocabulary',
    description:
      'The values a card field can take that belong to this machine rather than to the schema: the labels already ' +
      'used on the board (and which carry instructions for the agent), the saved workflows (slugs), the CLI agents ' +
      'installed with the approval modes each offers, the config directories already in use, and — when you pass ' +
      '`agentKind` — that CLI’s model ids and effort levels. Use it when you are about to set labels, a model, an ' +
      'effort, a workflow or a config directory on a card and need the exact spelling. Do not use it for anything ' +
      'the tool schemas already enumerate (columns, priorities, approval modes).',
    inputSchema: {
      type: 'object',
      properties: {
        agentKind: {
          type: 'string',
          enum: [...AGENT_KINDS],
          description:
            'Also list this CLI’s models and effort levels (the first listing for a CLI can take a few seconds). Omit to skip them.',
        },
        model: {
          type: 'string',
          description:
            'With `agentKind`: list the effort levels of THIS model, which can differ per model. Omit for the CLI’s general list.',
        },
      },
      additionalProperties: false,
    },
  },
  list_tasks: {
    name: 'list_tasks',
    description:
      'List cards on the board — key, id, title, column, priority, labels, due date and whether an agent run is ' +
      'attached — ordered by column then position. Use it when you need to find a card (by words, label or ' +
      'column) or see what a board holds before filing a duplicate. Do not use it to read one card in full — ' +
      'get_task does that.',
    inputSchema: {
      type: 'object',
      properties: {
        project: {
          ...PROJECT_ARG,
          description: `${PROJECT_ARG.description} Omit to list every project's cards.`,
        },
        status: {
          type: 'array',
          items: { type: 'string', enum: [...TASK_STATUSES] },
          description: `Only cards in these columns. ${enumList(TASK_STATUS_MEANINGS)}. Omit for every column.`,
        },
        label: {
          type: 'string',
          description:
            'Only cards carrying this label (case-insensitive). Omit for any.',
        },
        query: {
          type: 'string',
          description:
            'Only cards whose key, title or description contain this text (case-insensitive). Omit for any.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: BOARD_LIST_TASKS_MAX_LIMIT,
          description: `At most this many cards, 1–${BOARD_LIST_TASKS_MAX_LIMIT}. Default ${BOARD_LIST_TASKS_DEFAULT_LIMIT}.`,
        },
      },
      additionalProperties: false,
    },
  },
  get_task: {
    name: 'get_task',
    description:
      'Read one card in full: key, title, description, column, priority, labels, due date, its own run ' +
      'configuration (null fields inherit the project’s, listed beside them), the agent’s report, its branch, ' +
      'worktree and run, attached files and pull requests. Use it when you need a card’s current state — the user ' +
      'can move a card at any time — or its full brief. When this conversation is WORKING a card, omit `task` to ' +
      'read that card. Do not use it to re-read a brief you were given at the start of the conversation.',
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          ...TASK_REF_ARG,
          description: `${TASK_REF_ARG.description} Omit to read the card this conversation is working (if it works one).`,
        },
      },
      additionalProperties: false,
    },
  },
  create_task: {
    name: 'create_task',
    description:
      'File a new card on a project’s board. Use it whenever the user asks to create, file or add a ticket, task ' +
      'or card — never by editing files or calling the daemon’s HTTP API. Every field below is optional except ' +
      '`project` and `title`; an omitted run-configuration field (' +
      TASK_RUN_CONFIG_FIELDS.join(', ') +
      ') INHERITS the project’s, and the answer names what was inherited. New cards go to ' +
      '`backlog` unless you pass `status`. ' +
      AUTOPILOT_HAZARD +
      ' ' +
      NOT_A_CHECKLIST +
      ' The answer gives the new card’s key, column and every field it holds, so you can report it without a ' +
      'second call. Do NOT use it to change an existing card — update_task does that — and look with list_tasks ' +
      'first if a similar card may already exist.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_ARG,
        ...cardFieldArgs(false),
        status: {
          ...STATUS_ARG,
          description: `${STATUS_ARG.description} Default \`backlog\`. Mind the autopilot: an armed project's intake column starts an agent.`,
        },
        sourceRef: {
          type: 'string',
          description: `The card's id in another system it was copied from (e.g. a Linear or Jira key), 1–${TASK_SOURCE_REF_MAX} characters. Optional.`,
        },
      },
      required: ['project', 'title'],
      additionalProperties: false,
    },
  },
  update_task: {
    name: 'update_task',
    description:
      'Change a card — any of its fields, its column, and the agent report — in one call; only the fields you ' +
      'pass change. Use it when you change or move any card, and, when this conversation is WORKING a card, to finish it: ' +
      'send `report` together with `status` (`in_review` when there is something for a person to review, `done` ' +
      'only when nothing is left to review, `failed` when you could not do the task). For the card you are working, ' +
      '`task` may be omitted, and only ' +
      `${TASK_AGENT_OWN_STATUSES.map((status) => `\`${status}\``).join(', ')} are allowed (sending it back to the ` +
      'intake would make the autopilot re-run you). The run-owned fields — the run, branch, worktree, number and ' +
      'project — cannot be changed. ' +
      AUTOPILOT_HAZARD +
      ' ' +
      NOT_A_CHECKLIST +
      ' Do NOT use it to narrate progress while you work — a report is the final account — and do not use it to ' +
      'create a card (create_task).',
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          ...TASK_REF_ARG,
          description: `${TASK_REF_ARG.description} Omit ONLY to change the card this conversation is working.`,
        },
        ...cardFieldArgs(true),
        status: {
          ...STATUS_ARG,
          description: `Move the card to this column. ${enumList(TASK_STATUS_MEANINGS)}. Omit to leave it where it is.`,
        },
        fromStatus: {
          type: 'string',
          enum: [...TASK_STATUSES],
          description:
            'With `status`: the column you believe the card is in now. When it has moved since you read it, nothing ' +
            'is changed and the answer says where it is. Omit to move it from wherever it is.',
        },
        report: {
          type: 'string',
          description:
            `The agent's report on the work, as markdown, at most ${TASK_REPORT_MAX} characters: what changed, what ` +
            'was verified, what was deliberately left undone, and the pull request link when there is one. Each ' +
            'report REPLACES the previous one, so send the whole account. Reference screenshots as markdown images ' +
            'with ABSOLUTE paths — `![what it shows](/abs/path.png)` — and each is copied onto the card. Omit to ' +
            'leave the report as it is.',
        },
      },
      additionalProperties: false,
    },
  },
};

/** Every board tool, in the order they are listed. */
export const BOARD_TOOLS: readonly TaskBoardTool[] = Object.values(TOOLS);

/**
 * The arguments a board tool accepts — read off its own schema, so the
 * listing and the refusal of an unknown argument cannot disagree.
 */
export function boardToolArgs(name: HostBoardTool): string[] {
  return Object.keys(
    (TOOLS[name].inputSchema.properties ?? {}) as Record<string, unknown>,
  );
}
