import { ShieldQuestion } from 'lucide-react';

import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';

/**
 * Elicitation card for an `ask`-node's paused tool call. Live (no verdict
 * yet) it offers Approve/Deny; once the persisted `approval_verdict` item
 * arrives (or replays after reconnect) it renders the settled state — the
 * verdict item is the durable acknowledgment, so the card needs no local
 * optimistic state.
 */
export function ApprovalCard({
  toolName,
  input,
  verdict,
  expired = false,
  onRespond,
}: {
  toolName: string;
  input: unknown;
  /** null while pending; the user's answer once the verdict item arrived. */
  verdict: boolean | null;
  /** The turn ended before an answer — no verdict can apply anymore. */
  expired?: boolean;
  onRespond: (allow: boolean) => void;
}): React.JSX.Element {
  let inputPreview: string;
  try {
    inputPreview = JSON.stringify(input, null, 2);
  } catch {
    inputPreview = String(input);
  }
  return (
    <Card className="flex flex-col gap-2.5 border-primary/40 p-3">
      <div className="flex items-center gap-2">
        <ShieldQuestion
          aria-hidden="true"
          className="size-4 shrink-0 text-primary"
        />
        <span className="text-sm font-medium">Agent asks to run a tool</span>
        <Badge variant="secondary">{toolName}</Badge>
      </div>
      <pre className="m-0 max-h-48 overflow-auto rounded-md bg-muted p-2 font-mono text-xs whitespace-pre-wrap">
        {inputPreview}
      </pre>
      {expired && verdict === null ? (
        <p className="text-xs text-muted-foreground">
          ⏱ expired — the turn ended before an answer
        </p>
      ) : verdict === null ? (
        <div className="flex gap-2">
          <Button type="button" onClick={() => onRespond(true)}>
            Approve
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => onRespond(false)}>
            Deny
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          {verdict ? '✓ approved' : '✗ denied'}
        </p>
      )}
    </Card>
  );
}
