import { Globe } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { cn } from '../../components/ui/utils';
import { isRemoteRuntime } from '../../remote/remote-session';
import { useThreadFlag } from '../thread-ui-memory';
import {
  BROWSER_PANE_OPEN_KEY,
  clearAgentTabUnseen,
  useAgentTabUnseen,
} from './browser-pane-store';

export const BROWSER_REMOTE_TITLE = 'The browser runs on your Mac';

/** The chat header's globe: shows or hides the chat's browser pane. */
export function BrowserToggleButton({
  runId,
}: {
  runId: string;
}): React.JSX.Element {
  const [open, setOpen] = useThreadFlag(BROWSER_PANE_OPEN_KEY, false);
  const unseen = useAgentTabUnseen(runId);
  const remote = isRemoteRuntime();
  const title = remote
    ? BROWSER_REMOTE_TITLE
    : open
      ? 'Hide browser'
      : unseen
        ? 'Show browser — an agent opened a tab'
        : 'Show browser';
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      data-slot="browser-toggle"
      className={cn('relative size-7', open && 'text-primary')}
      aria-label="Browser"
      aria-pressed={remote ? undefined : open}
      aria-disabled={remote ? true : undefined}
      title={title}
      onClick={() => {
        if (remote) {
          return;
        }
        if (!open) {
          clearAgentTabUnseen(runId);
        }
        setOpen(!open);
      }}>
      <Globe />
      {unseen && !open ? (
        <span
          data-slot="browser-unseen-dot"
          aria-hidden="true"
          className="absolute top-1 right-1 size-1.5 rounded-pill bg-primary"
        />
      ) : null}
    </Button>
  );
}
