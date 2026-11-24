import { Folder } from 'lucide-react';

import type { ProfileColor } from '../../shared/contracts';
import { PaletteDot } from '../components/ui/palette-dot';
import { cn } from '../components/ui/utils';

export const NO_PROJECT_NAME = 'No project';

const FRAME_CLASS: Record<ProfileColor, string> = {
  blue: 'border-group-blue/60',
  purple: 'border-group-purple/60',
  green: 'border-group-green/60',
  orange: 'border-group-orange/60',
  pink: 'border-group-pink/60',
  indigo: 'border-group-indigo/60',
  teal: 'border-group-teal/60',
  red: 'border-group-red/60',
};

export interface ProjectBlockProps {
  name: string;
  /** The project's colour on the graph; null for the threads of no project. */
  color: ProfileColor | null;
  threads: number;
  working: number;
}

/** The project's name and how many of its threads stand on the graph and how many work. */
export function ProjectBlockHeader({
  name,
  color,
  threads,
  working,
  className,
}: ProjectBlockProps & { className?: string }): React.JSX.Element {
  return (
    <div
      data-slot="project-block-header"
      className={cn(
        'flex min-w-0 items-center gap-2 text-xs text-muted-foreground',
        className,
      )}>
      <Folder aria-hidden="true" className="size-3.5 shrink-0" />
      {color === null ? null : <PaletteDot color={color} size="md" />}
      <span className="truncate text-sm font-medium text-foreground">
        {name}
      </span>
      <span className="shrink-0 tabular-nums">
        {threads}
        {working > 0 ? ` · ${working} working` : ''}
      </span>
    </div>
  );
}

/** One project's threads on the command center's canvas: a dashed frame in its colour, headed by its name. */
export function ProjectBlock(props: ProjectBlockProps): React.JSX.Element {
  return (
    <section
      aria-label={`Project ${props.name}`}
      data-slot="project-block"
      data-color={props.color ?? undefined}
      className={cn(
        'size-full rounded-card border-2 border-dashed bg-muted/20',
        props.color === null
          ? 'border-border-strong'
          : FRAME_CLASS[props.color],
      )}>
      <ProjectBlockHeader {...props} className="h-10 px-4" />
    </section>
  );
}
