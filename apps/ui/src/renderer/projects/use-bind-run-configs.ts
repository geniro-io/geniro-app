import { useEffect, useRef } from 'react';

import { useLatestCallback } from '../components/use-latest-callback';
import type { DaemonApis } from '../daemon-api';
import type { RunConfigSources } from './use-run-config-sources';

/**
 * Binds each run configuration that names no project to the project its folder
 * belongs to, by the daemon's own folder rule — the project its runs already
 * reached — once per configuration while the Projects screen is mounted. A
 * folder no project holds, or one the daemon could not answer for, leaves the
 * configuration unbound and listed for the user to place.
 */
export function useBindRunConfigsByFolder(
  apis: DaemonApis | null,
  projectsLoaded: boolean,
  sources: Pick<RunConfigSources, 'runConfigs' | 'writeRunConfigs'>,
  onError: (message: string) => void,
): void {
  const reportError = useLatestCallback(
    (message: string) => onError(message),
    [onError],
  );
  const tried = useRef(new Set<string>());
  const { runConfigs, writeRunConfigs } = sources;

  useEffect(() => {
    if (apis === null || !projectsLoaded) {
      return;
    }
    const pending = runConfigs.filter(
      (config) => !config.projectId && !tried.current.has(config.id),
    );
    if (pending.length === 0) {
      return;
    }
    for (const config of pending) {
      tried.current.add(config.id);
    }
    void Promise.all(
      pending.map(async (config) => {
        try {
          const { project } = await apis.projects.resolveProjectForFolder({
            path: config.cwd,
          });
          return project === null
            ? null
            : { configId: config.id, projectId: project.id };
        } catch {
          return null;
        }
      }),
    ).then((answers) => {
      const bound = new Map(
        answers.flatMap((answer) =>
          answer === null ? [] : [[answer.configId, answer.projectId]],
        ),
      );
      if (bound.size === 0) {
        return;
      }
      void writeRunConfigs((current) =>
        current.map((config) => {
          const projectId = bound.get(config.id);
          return projectId !== undefined && !config.projectId
            ? { ...config, projectId }
            : config;
        }),
      ).catch((err: unknown) => reportError(String(err)));
    });
  }, [apis, projectsLoaded, runConfigs, writeRunConfigs, reportError]);
}
