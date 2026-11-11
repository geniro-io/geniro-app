import { ChevronRight, Globe, ImageOff } from 'lucide-react';
import { useContext, useEffect, useState } from 'react';

import { Button } from '../components/ui/button';
import { ZoomableImage } from '../components/ui/image-viewer';
import { Spinner } from '../components/ui/spinner';
import { cn } from '../components/ui/utils';
import { SectionLabel } from './block-shell';
import { useBrowserPane } from './browser/browser-pane-context';
import { readBrowserScreenshot } from './browser-screenshot-payload';
import { RunSettledContext } from './live-row';
import { LocalImageLoaderContext, refusalFor } from './local-image-loader';
import { useThreadFlag } from './thread-ui-memory';
import { toolPairStatus } from './tool-group';
import type { ToolPair } from './transcript-groups';

type ScreenshotImage =
  { kind: 'ready'; url: string } | { kind: 'failed'; reason: string };

/**
 * The saved picture as a `data:` URL, read through the same loader a markdown
 * image and a gallery tile use, and RELEASED when the card folds: the bytes are
 * held only while the card is open, for the reason the gallery's walk is.
 */
function useScreenshotImage(
  path: string | null,
  enabled: boolean,
): { image: ScreenshotImage | null; loaderMissing: boolean } {
  const load = useContext(LocalImageLoaderContext);
  const [image, setImage] = useState<ScreenshotImage | null>(null);
  useEffect(() => {
    if (!enabled || path === null) {
      setImage(null);
      return;
    }
    const refusal = refusalFor(path);
    if (refusal !== null) {
      setImage({ kind: 'failed', reason: refusal });
      return;
    }
    if (load === null) {
      return;
    }
    let live = true;
    load(path).then(
      (url) => {
        if (live) {
          setImage({ kind: 'ready', url });
        }
      },
      () => {
        if (live) {
          setImage({ kind: 'failed', reason: 'could not be read' });
        }
      },
    );
    return () => {
      live = false;
    };
  }, [path, enabled, load]);
  return { image, loaderMissing: load === null };
}

/**
 * What an agent saw in the in-app browser: the picture `browser_screenshot`
 * saved, drawn from its call and its result, with a way back to the tab.
 *
 * Folded away it holds no bytes; open it loads the one file through
 * {@link LocalImageLoaderContext}, never a remote address.
 */
export function BrowserScreenshotCard({
  pair,
  memoryKey,
}: {
  pair: ToolPair;
  /** Where the card's fold is remembered within its thread. */
  memoryKey?: string;
}): React.JSX.Element {
  const settled = useContext(RunSettledContext) !== null;
  const status = toolPairStatus(pair, settled);
  const shot = readBrowserScreenshot(pair);
  const [open, setOpen] = useThreadFlag(memoryKey, true);
  const { image, loaderMissing } = useScreenshotImage(shot.path, open);
  const pane = useBrowserPane();
  const caption =
    shot.tab === null ? 'Screenshot' : `Screenshot of ${shot.tab}`;
  const note =
    status === 'stopped'
      ? 'no result'
      : shot.failed
        ? `Screenshot failed: ${shot.note ?? 'no reason given'}`
        : (shot.note ?? 'No picture was saved');
  let body: React.ReactNode;
  if (status === 'running') {
    body = (
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        Taking a screenshot… <Spinner />
      </span>
    );
  } else if (shot.path === null) {
    body = (
      <span
        className={cn(
          'text-xs',
          shot.failed ? 'text-destructive' : 'text-muted-foreground',
        )}>
        {note}
      </span>
    );
  } else if (image?.kind === 'ready') {
    body = (
      <ZoomableImage
        src={image.url}
        alt={caption}
        title={caption}
        imgSlot="browser-screenshot-image"
        className="block max-w-full overflow-hidden rounded-lg border border-border"
        imgClassName="block max-h-80 w-auto max-w-full object-contain"
      />
    );
  } else {
    body = (
      <span
        data-slot="browser-screenshot-placeholder"
        className="flex h-24 w-48 items-center justify-center gap-1 rounded-lg border border-border bg-muted px-2 text-center text-[11px] text-muted-foreground">
        {image === null && !loaderMissing ? (
          'loading…'
        ) : (
          <>
            <ImageOff aria-hidden="true" className="size-3" />
            {image?.reason ?? 'no image loader'}
          </>
        )}
      </span>
    );
  }
  return (
    <div
      data-slot="browser-screenshot-card"
      data-open={open}
      className="min-w-0">
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
          {caption}
        </button>
      </SectionLabel>
      {open ? (
        <div className="flex min-w-0 flex-col items-start gap-1.5">
          {body}
          {pane === null ? null : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => pane.openPane(shot.tab)}>
              <Globe aria-hidden="true" />
              Show in browser
            </Button>
          )}
        </div>
      ) : null}
    </div>
  );
}
