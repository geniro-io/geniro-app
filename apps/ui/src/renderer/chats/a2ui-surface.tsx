import { PanelsTopLeft } from 'lucide-react';
import { useContext } from 'react';

import { Card } from '../components/ui/card';
import { SurfaceBody } from './a2ui-components';
import type { SurfaceRow } from './a2ui-payload';
import { SectionLabel } from './block-shell';
import {
  type SurfaceHost,
  SurfaceHostContext,
  useSurface,
} from './use-surface';

export function SurfaceCard({ row }: { row: SurfaceRow }): React.JSX.Element {
  const host = useContext(SurfaceHostContext);
  return (
    <div data-slot="surface-card" className="min-w-0">
      <SectionLabel>
        <span className="flex min-w-0 items-center gap-1.5">
          <PanelsTopLeft aria-hidden="true" className="size-3 shrink-0" />
          {row.title ?? 'Card'}
        </span>
      </SectionLabel>
      {host === null ? (
        <p className="m-0 text-xs text-muted-foreground">
          This card opens in its chat.
        </p>
      ) : (
        <LiveSurface host={host} surfaceId={row.surfaceId} />
      )}
    </div>
  );
}

function LiveSurface({
  host,
  surfaceId,
}: {
  host: SurfaceHost;
  surfaceId: string;
}): React.JSX.Element {
  const state = useSurface(host, surfaceId);
  const { surface, error } = state;
  if (surface === null) {
    return error === null ? (
      <div className="h-16 animate-pulse rounded-lg bg-muted" />
    ) : (
      <p className="m-0 text-xs text-destructive">{error}</p>
    );
  }
  const removed = surface.removed;
  return (
    <Card
      data-slot="surface-body"
      data-removed={removed ? 'true' : undefined}
      className="gap-0 p-3">
      <div inert={removed} className={removed ? 'opacity-60' : undefined}>
        <SurfaceBody surface={surface} state={state} inert={removed} />
      </div>
      {removed ? (
        <p className="m-0 mt-2 text-xs text-muted-foreground">
          Card removed by the agent
        </p>
      ) : null}
      {error === null ? null : (
        <p className="m-0 mt-2 text-xs text-destructive">{error}</p>
      )}
    </Card>
  );
}
