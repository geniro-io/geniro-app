import { existsSync } from 'node:fs';

import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';

import type { RunWire, StartWorkflowAnalysis } from '../../agents/chat.types';
import { ThreadAnalysisService } from '../../agents/services/thread-analysis.service';
import { WorkflowStoreService } from './workflow-store.service';

/**
 * "Analyze & improve" on a library workflow: what the library knows that the
 * analysis itself cannot — that the workflow exists, and its name — put in
 * front of
 * `ThreadAnalysisService`, which starts and reads it. Lives here because
 * `GraphsModule` imports `AgentsModule`, never the reverse.
 */
@Injectable()
export class WorkflowAnalysisService implements OnApplicationBootstrap {
  private readonly logger = new Logger(WorkflowAnalysisService.name);

  constructor(
    private readonly store: WorkflowStoreService,
    private readonly analyses: ThreadAnalysisService,
  ) {}

  /**
   * A workflow deleted while the daemon was down, or whose delete failed
   * after the file went, leaves analyses about nothing — swept once per boot,
   * off the ready path.
   */
  onApplicationBootstrap(): void {
    void this.sweepOrphans().catch((err: unknown) => {
      this.logger.warn(
        `orphaned workflow analyses not swept: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  /** Delete the analyses of every workflow the library no longer holds. */
  async sweepOrphans(): Promise<void> {
    for (const slug of await this.analyses.analysedWorkflowSlugs()) {
      if (!this.holds(slug)) {
        await this.analyses.deleteWorkflowAnalyses(slug);
      }
    }
  }

  /** The workflow's analysis, or null; 404 for a workflow the library lacks. */
  async find(slug: string): Promise<RunWire | null> {
    await this.store.get(slug);
    return this.analyses.findWorkflowAnalysis(slug);
  }

  /** Start the workflow's analysis over its newest runs, replacing its last. */
  async start(slug: string, input: StartWorkflowAnalysis): Promise<RunWire> {
    const { workflow } = await this.store.get(slug);
    return this.analyses.startWorkflow({ slug, name: workflow.name }, input);
  }

  /**
   * Whether the library still has this workflow's file. A slug the store
   * refuses outright names no file it could hold.
   */
  private holds(slug: string): boolean {
    try {
      return existsSync(this.store.locate(slug).path);
    } catch {
      return false;
    }
  }
}
