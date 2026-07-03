import { Workflow } from 'lucide-react';

/**
 * Placeholder for the graph builder. Composing a DAG of agents is an M3
 * milestone; this keeps the destination present in the nav so the shell is
 * complete, and states plainly that it's coming.
 */
export function Graphs(): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
      <Workflow
        aria-hidden="true"
        className="size-10 text-muted-foreground/50"
      />
      <div className="flex max-w-sm flex-col gap-1.5">
        <h2 className="text-lg font-medium">Graphs</h2>
        <p className="text-sm text-muted-foreground">
          Compose a DAG of CLI agents that work as a team. The graph builder
          arrives in a later milestone.
        </p>
      </div>
    </div>
  );
}
