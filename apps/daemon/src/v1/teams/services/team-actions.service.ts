import { Injectable } from '@nestjs/common';
import { ConflictException } from '@packages/common';

import type {
  ActionPressWire,
  ActionVia,
  LiveAction,
  SurfacePressBody,
  SurfaceWire,
} from '../../agents/chat.types';
import { ActionPressService } from '../../agents/services/action-press.service';
import {
  type SurfacePressMessage,
  SurfaceService,
} from '../../agents/services/surface.service';
import { TeamExecutorService } from './team-executor.service';

/**
 * A press or dismissal of a button in a TEAM run — the chat's press, with
 * the run's own delivery. Here rather than in `v1/agents` for
 * `TeamChatService`'s reason: `TeamsModule` imports `AgentsModule`, so
 * only this side can reach the executor.
 *
 * A message goes where a typed one does — the run's lead at the press
 * (`TeamExecutorService.sendMessage`) — never back to the publisher's own
 * conversation, which may have settled long before the press.
 */
@Injectable()
export class TeamActionsService {
  constructor(
    private readonly presses: ActionPressService,
    private readonly executor: TeamExecutorService,
    private readonly surfaces: SurfaceService,
  ) {}

  /** A card press reaches the call that drew the card while it runs, else the lead. */
  async pressSurface(
    runId: string,
    surfaceId: string,
    body: SurfacePressBody,
  ): Promise<SurfaceWire> {
    await this.presses.assertPressable(runId, 'team');
    return this.surfaces.press(runId, surfaceId, body, (message) =>
      this.deliverPress(runId, message),
    );
  }

  private async deliverPress(
    runId: string,
    message: SurfacePressMessage,
  ): Promise<void> {
    const { publisher } = message;
    if (publisher.callId !== null) {
      try {
        await this.executor.sendCallMessage(
          runId,
          publisher.memberId,
          publisher.callId,
          message.text,
          [],
          message.clientMessageId,
          message.storedText,
        );
        return;
      } catch (error) {
        if (
          !(error instanceof ConflictException) ||
          error.code !== 'CALL_NOT_RUNNING'
        ) {
          throw error;
        }
      }
    }
    const from =
      publisher.agentLabel === null
        ? ''
        : `From ${publisher.agentLabel} (card "${message.title ?? 'untitled'}"):\n`;
    await this.executor.sendMessage(
      runId,
      from + message.text,
      [],
      message.clientMessageId,
      undefined,
      from + message.storedText,
    );
  }

  async press(
    runId: string,
    seq: number,
    clientMessageId: string,
    via: ActionVia,
  ): Promise<ActionPressWire> {
    return this.presses.press(runId, seq, {
      run: 'team',
      clientMessageId,
      via,
      deliverMessage: (text, id, action) =>
        this.executor.sendMessage(runId, attributed(text, action), [], id),
    });
  }

  async dismiss(
    runId: string,
    seq: number,
    via: ActionVia,
  ): Promise<ActionPressWire> {
    return this.presses.dismiss(runId, seq, via, 'team');
  }
}

/**
 * The press's message as the receiving agents read it: prefixed with who
 * published it whenever the publisher carries an `agentLabel`, which
 * `TeamExecutorService.registerActionPublishers` withholds only from a
 * `lead`-mode run's lead speaking in its own conversation.
 */
function attributed(text: string, action: LiveAction): string {
  const agent = action.publisher.agentLabel;
  return agent === undefined
    ? text
    : `From ${agent} (action "${action.label}"):\n${text}`;
}
