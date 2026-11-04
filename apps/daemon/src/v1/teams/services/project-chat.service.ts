import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { NotFoundException } from '@packages/common';

import type { RunWire } from '../../agents/chat.types';
import { ChatService } from '../../agents/services/chat.service';
import type { ProjectWire } from '../../projects/projects.types';
import { ProjectEventBus } from '../../projects/services/project-events.bus';
import { ProjectsService } from '../../projects/services/projects.service';
import type { StartProjectChatInput } from '../teams.types';
import {
  composeProjectChatInstructions,
  type ProjectChatTarget,
} from '../utils/project-chat-instructions';
import { serializeTeamOverlayYaml } from '../utils/team-overlay-yaml';
import { TeamOverlayService } from './team-overlay.service';
import { TeamStoreService } from './team-store.service';

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The conversation behind a project page's chat panel: the user asks in prose
 * for a change to the project — its instruction blocks, or what its default
 * team does in it (the overlay) — and the agent puts it on a card.
 *
 * An ORDINARY CHAT in the project's folder, like `TeamChatService`'s, marked
 * by `Run.editsProjectId` with no team slug. `ChatService` re-briefs it before
 * each turn and installs its standing to change the project
 * (`ProjectChatBroker`) from the source this service installs.
 */
@Injectable()
export class ProjectChatService
  implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(ProjectChatService.name);
  /** Opens in flight, keyed by project — see `TeamChatService.opening`. */
  private readonly opening = new Map<string, Promise<RunWire>>();
  private subscription: { unsubscribe(): void } | null = null;

  constructor(
    private readonly chats: ChatService,
    private readonly projects: ProjectsService,
    private readonly store: TeamStoreService,
    private readonly overlays: TeamOverlayService,
    private readonly projectEvents: ProjectEventBus,
  ) {}

  onModuleInit(): void {
    this.chats.useProjectChat({
      brief: (projectId, cwd) => this.briefFor(projectId, cwd),
      teamOf: async (projectId) =>
        this.defaultTeamOf(await this.projects.get(projectId)),
    });
    this.subscription = this.projectEvents
      .allChanges()
      .subscribe(({ projectId }) => {
        void this.discardIfProjectGone(projectId);
      });
  }

  /** A project deleted while the daemon was down leaves its chat behind — swept once per boot, off the ready path. */
  onApplicationBootstrap(): void {
    void this.sweepOrphans();
  }

  onModuleDestroy(): void {
    this.subscription?.unsubscribe();
  }

  /**
   * The project's chat: the one that exists, or a new one in its folder.
   * The composer settings apply only to a chat being created.
   */
  open(projectId: string, input: StartProjectChatInput): Promise<RunWire> {
    const inFlight = this.opening.get(projectId);
    if (inFlight !== undefined) {
      return inFlight;
    }
    const started = this.openOnce(projectId, input).finally(() => {
      this.opening.delete(projectId);
    });
    this.opening.set(projectId, started);
    return started;
  }

  /** **Destructive and irreversible**: throw the project's chat away so the next open starts afresh. */
  discard(projectId: string): Promise<{ deleted: number }> {
    return this.chats.deleteProjectChats(projectId);
  }

  private async openOnce(
    projectId: string,
    input: StartProjectChatInput,
  ): Promise<RunWire> {
    const project = await this.projects.get(projectId);
    const existing = await this.chats.findProjectChat(projectId);
    if (existing !== null) {
      await this.chats.refreshTeamInstructions(
        existing.id,
        await this.briefFor(projectId, existing.cwd ?? project.folder),
      );
      return existing;
    }
    return this.chats.createChat({
      ...input,
      approval: this.chats.offeredApproval(input.agentKind, input.approval),
      cwd: project.folder,
      title: `Project: ${project.name}`,
      projectId,
      editsProjectId: projectId,
      teamInstructions: await this.briefFor(projectId, project.folder),
    });
  }

  private async defaultTeamOf(project: ProjectWire): Promise<string | null> {
    const slug = project.teamSlug;
    return slug !== null && slug !== '' && (await this.store.has(slug))
      ? slug
      : null;
  }

  private async briefFor(projectId: string, cwd: string): Promise<string> {
    const project = await this.projects.get(projectId);
    return composeProjectChatInstructions({
      project: {
        id: project.id,
        name: project.name,
        folder: project.folder,
        description: project.description,
        blocks: project.instructionBlocks,
        revision: project.instructionsRevision,
      },
      target: await this.targetOf(project),
      inFolder: canonical(cwd) === canonical(project.folder),
    });
  }

  private async targetOf(project: ProjectWire): Promise<ProjectChatTarget> {
    const slug = await this.defaultTeamOf(project);
    if (slug === null) {
      return { kind: 'agent', agent: project.agentKind };
    }
    const { team } = await this.store.get(slug);
    const stored = await this.overlays.storedOverlay(slug, project.id);
    return {
      kind: 'team',
      slug,
      team,
      overlayPath: this.overlays.overlayPathOf(slug, project.id),
      overlayYaml:
        stored === null ? null : serializeTeamOverlayYaml(stored.overlay),
    };
  }

  private async discardIfProjectGone(projectId: string): Promise<void> {
    try {
      await this.projects.get(projectId);
      return;
    } catch (error) {
      if (!(error instanceof NotFoundException)) {
        this.logger.warn(
          `project ${projectId}'s chat kept: the project could not be read: ${messageOf(error)}`,
        );
        return;
      }
    }
    try {
      await this.discard(projectId);
    } catch (error) {
      this.logger.warn(
        `project ${projectId}'s chat could not be deleted with it: ${messageOf(error)}`,
      );
    }
  }

  private async sweepOrphans(): Promise<void> {
    try {
      for (const projectId of await this.chats.projectChatProjectIds()) {
        await this.discardIfProjectGone(projectId);
      }
    } catch (error) {
      this.logger.warn(`orphaned project chats not swept: ${messageOf(error)}`);
    }
  }
}
