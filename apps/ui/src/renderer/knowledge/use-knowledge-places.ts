import { useEffect, useMemo, useState } from 'react';

import { folderName } from '../chats/directory-select';
import type { DaemonApis } from '../daemon-api';
import type { DaemonClient } from '../daemon-client';
import { useProjects } from '../projects/use-projects';
import {
  GLOBAL_PLACE,
  type KnowledgePlace,
  projectPlace,
  teamPlace,
} from './knowledge-text';

/** Every place a document can be filed in: projects, then teams, then Global. */
export function useKnowledgePlaces(
  apis: DaemonApis | null,
  client: DaemonClient | null,
): { places: KnowledgePlace[]; loaded: boolean } {
  const { projects } = useProjects(apis, client);
  const [teams, setTeams] = useState<{ slug: string; name: string }[] | null>(
    null,
  );

  useEffect(() => {
    void apis?.teams
      .listTeams()
      .then(setTeams)
      .catch(() => undefined);
  }, [apis]);

  const places = useMemo(
    () => [
      ...(projects ?? []).map((project) => ({
        key: projectPlace(project.id),
        label: project.name,
        hint: folderName(project.folder),
        kind: 'project' as const,
      })),
      ...(teams ?? []).map((team) => ({
        key: teamPlace(team.slug),
        label: team.name,
        kind: 'team' as const,
      })),
      { key: GLOBAL_PLACE, label: 'Global', kind: 'global' as const },
    ],
    [projects, teams],
  );
  return { places, loaded: projects !== null && teams !== null };
}
