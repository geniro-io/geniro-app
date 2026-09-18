import { Injectable } from '@nestjs/common';

import type { RunWire } from '../../agents/chat.types';
import { ChatService } from '../../agents/services/chat.service';
import type { StartWorkflowChatInput } from '../graphs.types';
import { composeWorkflowChatInstructions } from '../utils/workflow-chat-instructions';
import { WorkflowStoreService } from './workflow-store.service';

/**
 * The conversation behind the workflow builder's chat panel — the user
 * describing a change in prose to an agent that edits the workflow file.
 *
 * It starts an ORDINARY CHAT rather than a second execution path: the agent
 * needs a working directory and its own file tools, which is exactly what a
 * chat already is, so this composes `ChatService` the way `TaskRunsService`
 * does for a board card's worktree. That is also why the dependency points
 * this way — `GraphsModule` imports `AgentsModule`, never the reverse.
 *
 * What this service knows and a chat cannot is the SUBJECT: where the library
 * keeps its files, and what a workflow document may contain. Both reach the
 * agent as a snapshotted brief on the run (`Run.workflowInstructions`).
 */
@Injectable()
export class WorkflowChatService {
  constructor(
    private readonly store: WorkflowStoreService,
    private readonly chats: ChatService,
  ) {}

  /**
   * The chat for one workflow: the one that already exists, or a new one.
   *
   * Get-or-create rather than create, because the panel is a place the user
   * comes BACK to — a second chat per press would leave the conversation they
   * had yesterday stranded behind a thread that knows nothing. The composer
   * settings therefore apply to a chat being created and are ignored for one
   * that already exists; changing the agent or model of an open conversation
   * is `PATCH /v1/chats/:runId`, exactly as it is on the chat screen.
   *
   * The workflow is READ first, so a slug naming nothing is the store's own
   * 404 rather than a chat pointed at a file that is not there.
   */
  async open(slug: string, input: StartWorkflowChatInput): Promise<RunWire> {
    const existing = await this.chats.findWorkflowChat(slug);
    if (existing !== null) {
      return existing;
    }
    const { workflow } = await this.store.get(slug);
    const location = this.store.locate(slug);
    return this.chats.createChat({
      ...input,
      // The LIBRARY directory, not the file: a cwd is a directory, and putting
      // the agent in the library is also what lets it read a sibling workflow
      // as an example. Which file is its own is the brief's job to say.
      cwd: location.directory,
      // Named at creation so the thread is findable in a sidebar listing every
      // other conversation — and so `ChatTitleService` leaves it alone, that
      // service only ever replacing a title it derived itself.
      title: `Workflow: ${workflow.name}`,
      editsWorkflowSlug: slug,
      workflowInstructions: composeWorkflowChatInstructions({
        path: location.path,
        name: workflow.name,
      }),
    });
  }

  /**
   * **Destructive and irreversible**: throw away every chat about one
   * workflow — the panel's own "start over", for a conversation that has gone
   * wrong.
   *
   * Takes a raw slug and reads no workflow, so {@link deleteWorkflow} can call
   * it once the file is already gone.
   */
  discard(slug: string): Promise<{ deleted: number }> {
    return this.chats.deleteWorkflowChats(slug);
  }

  /**
   * **Destructive and irreversible**: delete a workflow and every chat about
   * it.
   *
   * A chat whose only subject is a file that no longer exists has nothing left
   * to talk about — and its agent still carries a brief naming that file, so
   * leaving it behind means a thread that answers every message about a
   * workflow it cannot read. This is the one way these runs differ from a
   * board task's, where the conversation deliberately outlives the card.
   *
   * The cascade lives HERE rather than on the store for two reasons that point
   * the same way: `WorkflowStoreService` is a plain file store built from an
   * options bag with no DI at all, so it cannot reach a chat; and the route
   * may not orchestrate two services for itself
   * (`.claude/rules/daemon-module-structure.md`).
   *
   * The file goes FIRST, so a slug the library does not hold is its 404 and no
   * chat is destroyed for a workflow that was never there.
   */
  async deleteWorkflow(slug: string): Promise<void> {
    await this.store.delete(slug);
    await this.discard(slug);
  }
}
