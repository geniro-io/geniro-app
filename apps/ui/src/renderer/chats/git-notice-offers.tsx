import { cva } from 'class-variance-authority';

import type { BannerTone } from '../components/error-banner';
import { Button } from '../components/ui/button';
import type { GitNotice } from './use-git-info';

/**
 * A clickable STRING, not a bordered button. The strip is one sentence the app
 * is saying; a button beside it reads as a second control competing with the
 * composer's own, where what this is is the rest of the sentence — "the branch
 * stays put · bring changes along · pull latest". `link` is the app's one such
 * look, re-toned to the strip it sits in so it cannot read as unrelated
 * caramel.
 */
const offerLink = cva(
  'h-auto shrink-0 p-0 text-xs underline underline-offset-4',
  {
    variants: {
      tone: {
        warning: 'text-warning decoration-warning/40 hover:decoration-warning',
        error:
          'text-destructive decoration-destructive/40 hover:decoration-destructive',
      },
    },
  },
);

/**
 * The ways out of a branch switch refused over uncommitted work, as the end of
 * the composer strip's sentence.
 *
 * "Bring changes along" comes first because it is the one that reaches the
 * branch the user picked. "Pull latest" updates the branch the folder is still
 * on — useful, but it can never unblock the switch, since the work comes back
 * onto this branch afterwards.
 */
export function GitNoticeOffers({
  notice,
  pulling,
  carrying,
  onPull,
  onCarry,
}: {
  notice: GitNotice;
  pulling: boolean;
  carrying: boolean;
  onPull: () => void;
  onCarry: () => void;
}): React.JSX.Element | null {
  const { carryTo, offerPull } = notice;
  if (carryTo === null && !offerPull) {
    return null;
  }
  const busy = pulling || carrying;
  const tone: BannerTone = notice.tone;
  return (
    <span className="flex shrink-0 items-center gap-3">
      {carryTo !== null ? (
        <Button
          type="button"
          variant="link"
          size="sm"
          className={offerLink({ tone })}
          disabled={busy}
          title={`Stash your changes, switch to ${carryTo}, then put the changes back there`}
          onClick={onCarry}>
          {carrying ? 'Switching…' : 'Bring changes along'}
        </Button>
      ) : null}
      {offerPull ? (
        <Button
          type="button"
          variant="link"
          size="sm"
          className={offerLink({ tone })}
          disabled={busy}
          title="Stash your changes, fast-forward this branch, then put the changes back"
          onClick={onPull}>
          {pulling ? 'Pulling…' : 'Pull latest'}
        </Button>
      ) : null}
    </span>
  );
}
