import { Workflow as WorkflowIcon } from 'lucide-react';

import type { CliDetection } from '../../shared/contracts';
import { CLI_KINDS } from '../../shared/contracts';
import { Select } from '../components/ui/select';

/** The workflows a target picker can offer, by the two fields it shows. */
export interface TargetWorkflow {
  slug: string;
  name: string;
}

/**
 * What a run is pointed at — one of the CLIs on this machine, or a library
 * workflow to run as a team.
 */
export function TargetSelect({
  value,
  workflows,
  cliDetections,
  onChange,
}: {
  value: string;
  workflows: readonly TargetWorkflow[];
  /** Per-CLI detection, or null while the probe has not answered. */
  cliDetections: readonly CliDetection[] | null;
  onChange: (target: string) => void;
}): React.JSX.Element {
  return (
    <Select
      variant="ghost"
      value={value}
      aria-label="Agent or workflow for new runs"
      searchPlaceholder="Search agents, workflows…"
      groups={[
        {
          label: 'Agents',
          // An agent the machine cannot run is SHOWN and refused, not hidden: a
          // row that quietly vanishes leaves the user hunting for it, while a
          // disabled one with its reason beside it explains itself. The current
          // target is never refused — a configuration already on it would
          // otherwise have a picker that cannot display its own value.
          items: CLI_KINDS.map((kind) => {
            const detected = cliDetections?.find((d) => d.kind === kind);
            const missing =
              detected !== undefined && !detected.found && kind !== value;
            return {
              value: kind,
              label: kind,
              ...(missing ? { disabled: true, hint: 'not installed' } : {}),
            };
          }),
        },
        ...(workflows.length > 0
          ? [
              {
                label: 'Workflows',
                items: workflows.map((wf) => ({
                  value: `wf:${wf.slug}`,
                  label: wf.name,
                  icon: <WorkflowIcon />,
                })),
              },
            ]
          : []),
      ]}
      onValueChange={onChange}
    />
  );
}
