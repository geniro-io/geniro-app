import { SlidersHorizontal, Trash2 } from 'lucide-react';

import type { RunConfig } from '../../shared/contracts';
import { ProjectSelect } from '../chats/project-select';
import { isUnboundRunConfig } from '../chats/run-config';
import { RunConfigSummary } from '../chats/run-config-picker';
import { ConfirmActionButton } from '../components/confirm-action-button';
import { ProjectSection } from './project-section';
import type { ProjectRef } from './use-projects';

/**
 * The run configurations no listed project owns — saved before configurations
 * belonged to projects, or left by a deleted one — each waiting to be moved
 * into a project or deleted.
 */
export function UnboundRunConfigs({
  configs,
  projects,
  onMove,
  onDelete,
}: {
  configs: readonly RunConfig[];
  projects: readonly ProjectRef[];
  onMove: (configId: string, projectId: string) => void;
  onDelete: (configId: string) => void;
}): React.JSX.Element | null {
  const unbound = configs.filter((config) =>
    isUnboundRunConfig(config, projects),
  );
  if (unbound.length === 0) {
    return null;
  }
  return (
    <ProjectSection
      slot="unbound-run-configs"
      icon={<SlidersHorizontal />}
      title="Run configurations without a project"
      hint="Every configuration belongs to a project now. Move each of these into one; until then they stay in the + menu under No project.">
      <ul aria-label="Without a project" className="flex flex-col gap-2">
        {unbound.map((config) => (
          <li
            key={config.id}
            data-slot="unbound-run-config"
            className="flex flex-wrap items-center gap-2 rounded-control bg-muted/50 py-2 pr-2 pl-3 ring-1 ring-border/60">
            <div className="flex min-w-0 flex-1 basis-64 flex-col gap-0.5">
              <span className="truncate text-sm font-medium text-foreground">
                {config.name}
              </span>
              <RunConfigSummary config={config} projectName={null} />
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <div className="w-56">
                <ProjectSelect
                  projects={projects}
                  value={null}
                  noneLabel="Move to project…"
                  aria-label={`Project for ${config.name}`}
                  onChange={(projectId) => {
                    if (projectId !== null) {
                      onMove(config.id, projectId);
                    }
                  }}
                />
              </div>
              <ConfirmActionButton
                variant="ghost"
                size="icon"
                className="size-8 shrink-0 rounded-control text-muted-foreground"
                aria-label={`Delete ${config.name}`}
                title="Delete"
                question={`Delete ${config.name}?`}
                description="The saved configuration is deleted. Chats it started are kept."
                confirmLabel="Delete"
                busyLabel="Deleting…"
                onConfirm={() => onDelete(config.id)}>
                <Trash2 className="size-3.5" aria-hidden />
              </ConfirmActionButton>
            </div>
          </li>
        ))}
      </ul>
    </ProjectSection>
  );
}
