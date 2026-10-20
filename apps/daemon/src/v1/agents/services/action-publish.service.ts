import { Injectable, Logger } from '@nestjs/common';

import {
  ACTION_COMMAND_MAX,
  ACTION_COMMAND_TIMEOUT_DEFAULT_MINUTES,
  ACTION_COMMAND_TIMEOUT_MAX_MINUTES,
  ACTION_DESCRIPTION_MAX,
  ACTION_ID_MAX,
  ACTION_LABEL_MAX,
  ACTION_LIVE_MAX,
  ACTION_MESSAGE_MAX,
  type ActionCommandInput,
  type ActionPublisher,
  type ActionPublishInput,
  type ActionSpec,
  type ActionStopInput,
  type ActionToolOutcome,
  type LiveAction,
} from '../chat.types';
import { actionKey } from '../utils/action-fold';
import { ActionCommandService } from './action-command.service';
import { ActionStopService } from './action-stop.service';
import { ChatActionsService } from './chat-actions.service';

/** What a call's envelope says about one button published inside it. */
export interface PublishedActionNote {
  actionId: string;
  label: string;
  kind: ActionSpec['kind'];
}

/**
 * Who else is told about a publisher's buttons besides the run — a workflow
 * callee's running calls, whose envelopes list them.
 */
export interface ActionPublishNotes {
  /**
   * A publish passed every check and its row is about to be written. Told
   * before the write, so a call settling meanwhile still names it; the undo
   * runs when the write then fails. `key` is the button's `actionKey`.
   */
  published(key: string, action: PublishedActionNote): () => void;
  /** The button at `key` was removed by its publisher. */
  removed(key: string): void;
}

/** Who is publishing, bound in by the turn that registered the sink. */
export interface ActionPublishContext {
  runId: string;
  /** The row's `nodeId`: null for a chat's own rows. */
  rowNodeId: string | null;
  publisher: ActionPublisher;
  notes?: ActionPublishNotes;
}

const ACTION_ID_PATTERN = new RegExp(
  `^[\\p{L}\\p{N}][\\p{L}\\p{N}_-]{0,${ACTION_ID_MAX - 1}}$`,
  'u',
);

/**
 * Text that would show the user something other than what it holds: any
 * control, any format character (bidi overrides, isolates and marks,
 * zero-width characters, invisible tags), anything Unicode says to draw as
 * nothing, and the line and paragraph separators. Emoji stay usable, and only
 * by position: a joiner between two pictographs (a skin tone or a
 * presentation selector may sit before it), and one presentation selector
 * straight after an emoji. Every other variation selector is refused — they
 * draw as nothing, so a run of them could carry text nobody sees.
 */
const HIDDEN_TEXT =
  /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\u2028\u2029]/u;
const EMOJI_JOINER =
  /(?<=\p{Extended_Pictographic}[\p{Emoji_Modifier}\uFE0F]?)\u200D(?=\p{Extended_Pictographic})/gu;
const EMOJI_PRESENTATION = /(?<=\p{Emoji}\p{Emoji_Modifier}?)[\uFE0E\uFE0F]/gu;

/** `lineBreaks`: a message may hold tabs and newlines; a label is one line. */
function hasHiddenText(value: string, lineBreaks: boolean): boolean {
  const visible = value
    .replace(EMOJI_JOINER, '')
    .replace(EMOJI_PRESENTATION, '');
  return HIDDEN_TEXT.test(
    lineBreaks ? visible.replace(/[\t\n\r]/g, '') : visible,
  );
}

/**
 * Validates and records an agent's buttons. The rules live here rather than
 * in the tool's reader, so every publisher is held to the same ones.
 */
@Injectable()
export class ActionPublishService {
  private readonly logger = new Logger(ActionPublishService.name);

  constructor(
    private readonly actions: ChatActionsService,
    private readonly stops: ActionStopService,
    private readonly commands: ActionCommandService,
  ) {}

  async publish(
    ctx: ActionPublishContext,
    input: ActionPublishInput,
  ): Promise<ActionToolOutcome> {
    const checked = checkInput(input);
    if ('reason' in checked) {
      return { status: 'refused', reason: checked.reason };
    }
    const { label, description, actionId } = checked;
    let spec: ActionSpec;
    if ('stop' in checked) {
      // Outside the lock: a fresh process-table read is slow, and the cap
      // and live-set checks below do not depend on it.
      const resolved = await this.stops.resolve(
        ctx.runId,
        ctx.rowNodeId,
        checked.stop,
      );
      if ('reason' in resolved) {
        return { status: 'refused', reason: resolved.reason };
      }
      spec = { kind: 'stop', ...resolved };
    } else if ('command' in checked) {
      const resolved = await this.commands.resolveCwd(
        ctx.runId,
        checked.command.cwd,
      );
      if ('reason' in resolved) {
        return { status: 'refused', reason: resolved.reason };
      }
      spec = {
        kind: 'command',
        argv: checked.command.argv,
        cwd: resolved.cwd,
        timeoutMs:
          (checked.command.timeoutMinutes ??
            ACTION_COMMAND_TIMEOUT_DEFAULT_MINUTES) * 60_000,
        notifyAgent: checked.command.notifyAgent ?? false,
      };
    } else {
      spec = checked.spec;
    }
    const once = input.once ?? true;
    return this.actions.serialize(ctx.runId, async () => {
      const { live } = await this.actions.fold(ctx.runId);
      const key = actionKey(
        ctx.publisher.nodeId,
        ctx.publisher.conversationId,
        actionId,
      );
      const others = live.filter((action) => keyOf(action) !== key);
      if (others.length >= ACTION_LIVE_MAX) {
        return {
          status: 'refused',
          reason: `This chat already has ${ACTION_LIVE_MAX} live actions (${others.map((action) => action.actionId).join(', ')}). Remove one with remove_action, or re-publish one of yours by its action_id, before adding another.`,
        };
      }
      const unnote =
        ctx.notes?.published(key, { actionId, label, kind: spec.kind }) ??
        (() => {});
      try {
        await this.actions.appendAction(ctx.runId, ctx.rowNodeId, {
          actionId,
          label,
          ...(description === undefined ? {} : { description }),
          once,
          spec,
          publisher: ctx.publisher,
        });
      } catch (err) {
        unnote();
        // Kept out of the answer: a persist error names the database's path,
        // and the answer goes to a model whose provider is off this machine.
        this.logger.error(
          `run ${ctx.runId} could not persist an action: ${err instanceof Error ? err.message : String(err)}`,
        );
        return {
          status: 'refused',
          reason: 'the transcript row could not be written',
        };
      }
      return {
        status: 'published',
        text: `Published action "${actionId}" (${describeSpec(spec)}). Re-publish the same action_id to change it; remove_action "${actionId}" retires it. ${others.length + 1}/${ACTION_LIVE_MAX} live.`,
      };
    });
  }

  async remove(
    ctx: ActionPublishContext,
    actionId: string,
  ): Promise<ActionToolOutcome> {
    return this.actions.serialize(ctx.runId, async () => {
      const { live } = await this.actions.fold(ctx.runId);
      const own = live.filter(
        (action) =>
          action.nodeId === ctx.publisher.nodeId &&
          action.conversationId === ctx.publisher.conversationId,
      );
      const target = own.find((action) => action.actionId === actionId);
      if (target === undefined) {
        return {
          status: 'refused',
          reason: `No live action "${actionId}". ${own.length === 0 ? 'You have none live.' : `Yours: ${own.map((action) => action.actionId).join(', ')}.`}`,
        };
      }
      try {
        await this.actions.appendOutcome(ctx.runId, ctx.rowNodeId, {
          actionSeq: target.seq,
          actionId,
          nodeId: target.nodeId,
          conversationId: target.conversationId,
          state: 'removed',
        });
      } catch (err) {
        this.logger.error(
          `run ${ctx.runId} could not persist an action removal: ${err instanceof Error ? err.message : String(err)}`,
        );
        return {
          status: 'refused',
          reason: 'the transcript row could not be written',
        };
      }
      ctx.notes?.removed(keyOf(target));
      return { status: 'removed', text: `Removed action "${actionId}".` };
    });
  }
}

function keyOf(action: LiveAction): string {
  return actionKey(action.nodeId, action.conversationId, action.actionId);
}

type CheckedInput = {
  label: string;
  description: string | undefined;
  actionId: string;
} & (
  | { spec: ActionSpec }
  | { stop: ActionStopInput }
  | { command: ActionCommandInput }
);

/** The kind and what a press will stop or run — for the agent's receipt. */
function describeSpec(spec: ActionSpec): string {
  if (spec.kind === 'command') {
    return `command · ${spec.argv?.[0] ?? ''} in ${spec.cwd ?? ''}`;
  }
  if (spec.kind !== 'stop') {
    return spec.kind;
  }
  const pids = (spec.targets ?? []).map((target) => target.pid).join(', ');
  return spec.shellId === undefined
    ? `stop · pid ${pids}`
    : `stop · shell ${spec.shellId}: pid ${pids}`;
}

function checkInput(
  input: ActionPublishInput,
): CheckedInput | { reason: string } {
  const label = input.label.trim();
  if (label.length === 0 || label.length > ACTION_LABEL_MAX) {
    return { reason: `label must be 1–${ACTION_LABEL_MAX} characters` };
  }
  if (hasHiddenText(label, false)) {
    return {
      reason:
        'label must not contain control, invisible or bidirectional characters',
    };
  }
  const trimmed = input.description?.trim();
  const description =
    trimmed === undefined || trimmed === '' ? undefined : trimmed;
  if (description !== undefined) {
    if (description.length > ACTION_DESCRIPTION_MAX) {
      return {
        reason: `description must be at most ${ACTION_DESCRIPTION_MAX} characters`,
      };
    }
    if (hasHiddenText(description, false)) {
      return {
        reason:
          'description must not contain control, invisible or bidirectional characters',
      };
    }
  }
  const actionId = input.actionId ?? slugOf(label);
  if (!ACTION_ID_PATTERN.test(actionId)) {
    return {
      reason:
        input.actionId === undefined
          ? 'give an action_id: the label has no letters or digits to derive one from'
          : `action_id must be 1–${ACTION_ID_MAX} letters, digits, "-" or "_", starting with a letter or digit`,
    };
  }
  const kinds = [input.message, input.stop, input.command].filter(
    (value) => value !== undefined,
  );
  if (kinds.length !== 1) {
    return {
      reason: 'give exactly one of message, stop or command',
    };
  }
  if (input.stop !== undefined) {
    if ((input.stop.shell === undefined) === (input.stop.pid === undefined)) {
      return { reason: 'stop takes exactly one of shell or pid' };
    }
    if (input.once === false) {
      return {
        reason: 'a stop action is always one-shot; leave out once',
      };
    }
    return { label, description, actionId, stop: input.stop };
  }
  if (input.command !== undefined) {
    const command = checkCommand(input.command);
    return 'reason' in command
      ? command
      : { label, description, actionId, command };
  }
  // `kinds` above leaves the message as the one kind given.
  const text = (input.message ?? '').trim();
  if (text.length === 0 || text.length > ACTION_MESSAGE_MAX) {
    return { reason: `message must be 1–${ACTION_MESSAGE_MAX} characters` };
  }
  if (hasHiddenText(text, true)) {
    return {
      reason:
        'message must not contain control, invisible or bidirectional characters',
    };
  }
  return { label, description, actionId, spec: { kind: 'message', text } };
}

function checkCommand(
  command: ActionCommandInput,
): ActionCommandInput | { reason: string } {
  const { argv } = command;
  if (argv.length === 0 || argv.some((token) => token === '')) {
    return {
      reason:
        'command.argv must be a non-empty list of non-empty strings — the program first, then each argument',
    };
  }
  if (argv.join(' ').length > ACTION_COMMAND_MAX) {
    return {
      reason: `command.argv must be at most ${ACTION_COMMAND_MAX} characters in all`,
    };
  }
  // The confirm dialog shows these tokens as they are; one that draws as
  // something else would have the user run what they did not read.
  if (argv.some((token) => hasHiddenText(token, false))) {
    return {
      reason:
        'command.argv must not contain control, invisible or bidirectional characters (newlines included)',
    };
  }
  if (command.cwd !== undefined && hasHiddenText(command.cwd, false)) {
    return {
      reason:
        'command.cwd must not contain control, invisible or bidirectional characters',
    };
  }
  const minutes = command.timeoutMinutes;
  if (
    minutes !== undefined &&
    (minutes < 1 || minutes > ACTION_COMMAND_TIMEOUT_MAX_MINUTES)
  ) {
    return {
      reason: `command.timeout_minutes must be 1–${ACTION_COMMAND_TIMEOUT_MAX_MINUTES}`,
    };
  }
  return command;
}

/**
 * A default id from the label: letters and digits of any script, joined by
 * `-`, cut by code point so a character outside the BMP is never split.
 */
function slugOf(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return [...slug].slice(0, ACTION_ID_MAX).join('').replace(/-+$/, '');
}
