import { ChevronRight, ImageOff } from 'lucide-react';
import { useContext, useEffect, useRef, useState } from 'react';

import {
  ImageViewer,
  ZOOMABLE_TRIGGER_CLASS,
} from '../components/ui/image-viewer';
import { cn } from '../components/ui/utils';
import { SectionLabel } from './block-shell';
import type { GallerySpec } from './gallery-payload';
import { LocalImageLoaderContext, refusalFor } from './local-image-loader';

/**
 * One tile's state once the walk has reached it: the bytes, or why not.
 *
 * A union rather than `string | null`, because the two failures a reader can
 * act on differently — a scheme this app will not fetch, and a file it could
 * not read — deserve their own sentences.
 */
type GalleryTile =
  { kind: 'ready'; url: string } | { kind: 'failed'; reason: string };

/**
 * A set of pictures an agent handed over, shown as a grid that opens
 * full-screen.
 *
 * The render family's only card whose payload names FILES rather than carrying
 * its own content, so it is also the only one that has to LOAD anything. It
 * resolves each path through {@link LocalImageLoaderContext} — the same
 * loader a markdown image uses, over the same token-gated daemon route — rather
 * than a second fetch path, which is what keeps "how does a local picture reach
 * the screen" a question with one answer.
 *
 * Pressing a tile opens the app's ONE image surface with prev/next wired up, so
 * zoom, the modal contract and the portal all come from `image-viewer.tsx`
 * rather than from a lightbox of this card's own.
 */

/**
 * Loading is SEQUENTIAL, and only while the card is open.
 *
 * Each picture arrives as a `data:` URL and is held for as long as the card is
 * mounted, because the full-screen viewer needs the same bytes the tile shows —
 * there is no thumbnail endpoint, and the daemon's per-image ceiling is 20MB.
 * Firing every request at once would put the whole set in flight together on a
 * transcript that may hold several galleries. One at a time keeps the peak to
 * what is actually being decoded, and the grid fills visibly in order, which
 * also reads as progress rather than as a stall.
 */
function useGalleryImages(
  paths: readonly string[],
  enabled: boolean,
): { tiles: Map<string, GalleryTile>; loaderMissing: boolean } {
  const load = useContext(LocalImageLoaderContext);
  const [resolved, setResolved] = useState<Map<string, GalleryTile>>(new Map());
  // The CONTENT of the list, not the array. The card rebuilds `paths` on every
  // render, so depending on the array itself never settles: each pass resolves
  // a picture, the `setResolved` re-renders, the new array is a fresh identity,
  // and the walk restarts — a loop that re-fetches forever rather than failing.
  const key = paths.join('\n');
  // Read through a ref so the effect can depend on `key` ALONE and still walk
  // the current list. Sound because the two move together: `key` is derived
  // from `paths`, so a changed list always changes the key.
  const pathsRef = useRef(paths);
  pathsRef.current = paths;
  // What has already been ATTEMPTED, read the same way and for the same reason.
  // NOT a cache across collapses — the map is released when the card folds
  // away (below), so this only stops the walk re-reading within one open
  // stretch, when the effect re-runs while the card is still on screen.
  const resolvedRef = useRef(resolved);
  resolvedRef.current = resolved;

  useEffect(() => {
    if (!enabled) {
      // RELEASED on collapse, not merely left alone. Each picture is held as a
      // `data:` URL for as long as it is in this map, and a thread can hold
      // several galleries in an unvirtualized transcript — so a folded card
      // keeping 24 of them is memory nobody can see being spent. The cost is
      // that reopening reads them again, which is the trade this makes.
      setResolved((prev) => (prev.size === 0 ? prev : new Map()));
      return;
    }
    if (load === null) {
      // Nothing will ever resolve, and that is REPORTED rather than recorded:
      // writing a per-path failure here would put a card-wide condition into
      // the same map the walk reads as "already attempted", so a loader
      // arriving later would find every tile settled and never retry. The card
      // renders this state from `loaderMissing` instead.
      return;
    }
    let live = true;
    // Seeded from the committed map, then advanced SYNCHRONOUSLY as the walk
    // goes. `resolvedRef` only refreshes on commit, which lags the loop's own
    // awaits — so a path repeated later in one gallery would pass that check
    // before the first write landed and be fetched twice.
    const attempted = new Set(resolvedRef.current.keys());
    void (async () => {
      for (const path of pathsRef.current) {
        if (!live) {
          return;
        }
        // Anything already ATTEMPTED in THIS open stretch is skipped, a failure
        // included — an effect re-run while the card is still open must not
        // re-read what it already has. A reopen is a different matter: the map
        // was released, so nothing is skipped and the set is read again.
        if (attempted.has(path)) {
          continue;
        }
        attempted.add(path);
        // The FIRST door, the same one a markdown image passes through — the
        // daemon's own scheme check calls itself the second and is written on
        // the premise that the renderer refuses these before asking. Refusing
        // here also keeps the reason ("remote images are not loaded") instead
        // of the generic failure a 400 would produce.
        const refusal = refusalFor(path);
        if (refusal !== null) {
          setResolved((prev) =>
            new Map(prev).set(path, { kind: 'failed', reason: refusal }),
          );
          continue;
        }
        try {
          const url = await load(path);
          if (live) {
            setResolved((prev) =>
              new Map(prev).set(path, { kind: 'ready', url }),
            );
          }
        } catch {
          // A path that names nothing is one broken tile, never a failed card:
          // the agent produced the rest, and refusing to draw them would hide
          // the work over one moved file.
          if (live) {
            setResolved((prev) =>
              new Map(prev).set(path, {
                kind: 'failed',
                reason: 'could not be read',
              }),
            );
          }
        }
      }
    })();
    return () => {
      live = false;
    };
  }, [key, enabled, load]);

  return { tiles: resolved, loaderMissing: load === null };
}

export function GalleryCard({
  gallery,
}: {
  gallery: GallerySpec;
}): React.JSX.Element {
  const [open, setOpen] = useState(true);
  const [viewing, setViewing] = useState<number | null>(null);
  const paths = gallery.images.map((image) => image.path);
  const { tiles: resolved, loaderMissing } = useGalleryImages(paths, open);

  const count = gallery.images.length;
  const heading = [
    gallery.title ?? 'Images',
    `${count} ${count === 1 ? 'image' : 'images'}`,
  ].join(' · ');

  const active = viewing === null ? null : (gallery.images[viewing] ?? null);
  const activeTile = active === null ? undefined : resolved.get(active.path);
  const activeUrl = activeTile?.kind === 'ready' ? activeTile.url : null;

  // Which pictures can actually be SHOWN — the viewer is only rendered while it
  // holds a drawable image, so stepping onto one that failed or has not arrived
  // yet would drop the dialog out from under the reader with nothing said.
  // Navigation therefore walks this list rather than the raw index, skipping a
  // dead tile exactly as the grid refuses to open one. The list grows as the
  // sequential walk lands, so a neighbour that is merely slow becomes reachable
  // rather than staying skipped.
  const viewable = gallery.images.flatMap((image, index) =>
    resolved.get(image.path)?.kind === 'ready' ? [index] : [],
  );
  const place = viewing === null ? -1 : viewable.indexOf(viewing);
  const prevIndex = place > 0 ? viewable[place - 1] : undefined;
  const nextIndex =
    place >= 0 && place < viewable.length - 1 ? viewable[place + 1] : undefined;

  return (
    <div data-slot="gallery-card" data-open={open} className="min-w-0">
      <SectionLabel>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 items-center gap-1">
          <ChevronRight
            aria-hidden="true"
            className={cn('size-3 transition-transform', open && 'rotate-90')}
          />
          {heading}
        </button>
      </SectionLabel>
      {open ? (
        <ul
          data-slot="gallery-grid"
          // `auto-fill` with a floor rather than a fixed column count, on the
          // scorecard's reasoning: the transcript narrows when the agents panel
          // opens, and a fixed four columns would crush every tile there.
          className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-2 p-0">
          {gallery.images.map((image, index) => {
            const tile = resolved.get(image.path);
            return (
              <li key={`${image.path}-${index}`} className="m-0 min-w-0">
                <button
                  type="button"
                  data-slot="gallery-tile"
                  disabled={tile?.kind !== 'ready'}
                  aria-label={
                    image.caption
                      ? `View ${image.caption}`
                      : `View image ${index + 1} of ${count}`
                  }
                  title={image.caption ?? image.path}
                  onClick={() => setViewing(index)}
                  className={cn(
                    'block w-full overflow-hidden rounded-md border border-border',
                    // The trigger's own look comes from the primitive, so this
                    // opener cannot drift from the three that use
                    // `ZoomableImage` directly.
                    ZOOMABLE_TRIGGER_CLASS,
                    tile?.kind === 'ready' || 'cursor-default',
                  )}>
                  {tile?.kind === 'ready' ? (
                    <img
                      data-slot="gallery-image"
                      src={tile.url}
                      alt={image.caption ?? ''}
                      className="aspect-4/3 w-full object-cover"
                    />
                  ) : (
                    <span
                      data-slot="gallery-tile-placeholder"
                      className="flex aspect-4/3 w-full items-center justify-center gap-1 bg-muted px-2 text-center text-[11px] text-muted-foreground">
                      {tile === undefined && !loaderMissing ? (
                        'loading…'
                      ) : (
                        <>
                          <ImageOff aria-hidden="true" className="size-3" />
                          {tile?.reason ?? 'no image loader'}
                        </>
                      )}
                    </span>
                  )}
                </button>
                {image.caption === null ? null : (
                  <p
                    data-slot="gallery-caption"
                    className="m-0 truncate px-0.5 pt-1 text-[11px] text-muted-foreground"
                    title={image.caption}>
                    {image.caption}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
      {active !== null && activeUrl !== null ? (
        <ImageViewer
          open
          onClose={() => setViewing(null)}
          src={activeUrl}
          alt={active.caption ?? undefined}
          title={active.caption ?? active.path}
          // Position in the WHOLE set, not in `viewable`: the grid behind the
          // dialog shows every tile, so a reader counts against what they can
          // see rather than against what happened to load.
          position={{ index: viewing ?? 0, count }}
          // Withheld at the ends rather than wrapping: a set has a first and a
          // last picture, and silently looping makes a reader who is stepping
          // through lose their place in it. A withheld handler renders the
          // arrow disabled, which says so.
          onPrev={
            prevIndex === undefined ? undefined : () => setViewing(prevIndex)
          }
          onNext={
            nextIndex === undefined ? undefined : () => setViewing(nextIndex)
          }
        />
      ) : null}
    </div>
  );
}
