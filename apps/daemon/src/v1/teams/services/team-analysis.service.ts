import { existsSync } from 'node:fs';

import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';

import type { RunWire, StartTeamAnalysis } from '../../agents/chat.types';
import { ThreadAnalysisService } from '../../agents/services/thread-analysis.service';
import { TeamStoreService } from './team-store.service';

/**
 * "Analyze & improve" on a library team: what the library knows that the
 * analysis itself cannot — that the team exists, and its name — put in
 * front of
 * `ThreadAnalysisService`, which starts and reads it. Lives here because
 * `TeamsModule` imports `AgentsModule`, never the reverse.
 */
@Injectable()
export class TeamAnalysisService implements OnApplicationBootstrap {
  private readonly logger = new Logger(TeamAnalysisService.name);

  constructor(
    private readonly store: TeamStoreService,
    private readonly analyses: ThreadAnalysisService,
  ) {}

  /**
   * A team deleted while the daemon was down, or whose delete failed
   * after the file went, leaves analyses about nothing — swept once per boot,
   * off the ready path.
   */
  onApplicationBootstrap(): void {
    void this.sweepOrphans().catch((err: unknown) => {
      this.logger.warn(
        `orphaned team analyses not swept: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  /** Delete the analyses of every team the library no longer holds. */
  async sweepOrphans(): Promise<void> {
    for (const slug of await this.analyses.analysedTeamSlugs()) {
      if (!this.holds(slug)) {
        await this.analyses.deleteTeamAnalyses(slug);
      }
    }
  }

  /** The team's analysis, or null; 404 for a team the library lacks. */
  async find(slug: string): Promise<RunWire | null> {
    await this.store.get(slug);
    return this.analyses.findTeamAnalysis(slug);
  }

  /** Start the team's analysis over its newest runs, replacing its last. */
  async start(slug: string, input: StartTeamAnalysis): Promise<RunWire> {
    const { team } = await this.store.get(slug);
    return this.analyses.startTeam({ slug, name: team.name }, input);
  }

  /**
   * Whether the library still has this team's file. A slug the store
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
