import type { UpdateController } from '../updates/use-update-state';
import { Button } from './ui/button';

/**
 * The press a Geniro update waits on: Update now while one this install can
 * apply is offered, Restart now once it is installed, nothing otherwise. The
 * restart quits the app and takes the daemon and every running turn with it,
 * so it never happens without this press.
 */
export function AppUpdateActions({
  update,
}: {
  update: UpdateController;
}): React.JSX.Element | null {
  const state = update.state;
  if (state?.phase === 'available' && state.canInstall) {
    return (
      <Button
        type="button"
        variant="default"
        size="sm"
        title="Download and install the new version. Geniro keeps running until you press Restart now."
        onClick={() => void update.install()}>
        Update now
      </Button>
    );
  }
  if (state?.phase === 'ready') {
    return (
      <Button
        type="button"
        variant="default"
        size="sm"
        title="Close Geniro and open the new version. Agents working right now are stopped."
        onClick={() => void update.relaunch()}>
        Restart now
      </Button>
    );
  }
  return null;
}
