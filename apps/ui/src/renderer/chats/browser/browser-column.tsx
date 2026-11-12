import { useContext, useEffect, useLayoutEffect, useState } from 'react';

import { holdOverlay } from '../../components/browser-occlusion';
import {
  PanelResizeHandle,
  usePanelWidth,
} from '../../components/panel-resize';
import { Dialog } from '../../components/ui/dialog';
import { cn } from '../../components/ui/utils';
import { ThreadUiMemoryContext, useThreadFlag } from '../thread-ui-memory';
import { BrowserPane } from './browser-pane';
import {
  BROWSER_PANE_OPEN_KEY,
  clearAgentTabUnseen,
} from './browser-pane-store';

/** Under this much room for the pane and the transcript together, the pane covers the transcript. */
const OVERLAY_BELOW_PX = 520;

/** What the transcript keeps when the pane sits beside it. */
const TRANSCRIPT_MIN_PX = 280;

/**
 * The chat grid's browser column, between the transcript and the agents panel.
 * Always a grid item on a wide window, zero wide while the pane is closed, so
 * the agents panel stays in its own track.
 */
export function BrowserColumn({
  narrow,
  chatTitle,
}: {
  /** A phone-width window: no track, the pane covers the chat. */
  narrow: boolean;
  chatTitle: string;
}): React.JSX.Element | null {
  const runId = useContext(ThreadUiMemoryContext);
  const [open, setOpen] = useThreadFlag(BROWSER_PANE_OPEN_KEY, false);
  const { width, minWidth, maxWidth, startResize, resizeTo } = usePanelWidth({
    storageKey: 'chats.browserPaneWidth',
    defaultWidth: 440,
    minWidth: 320,
    maxWidth: 760,
    handleEdge: 'left',
  });
  const [column, setColumn] = useState<HTMLElement | null>(null);
  const [area, setArea] = useState<number | null>(null);
  const [fullScreen, setFullScreen] = useState(false);

  useEffect(() => {
    if (!open) {
      setFullScreen(false);
    }
  }, [open]);

  useEffect(() => {
    if (open && runId !== null) {
      clearAgentTabUnseen(runId);
    }
  }, [open, runId]);

  useLayoutEffect(() => {
    const transcript = column?.previousElementSibling;
    if (
      !open ||
      narrow ||
      !column ||
      !transcript ||
      typeof ResizeObserver === 'undefined'
    ) {
      setArea(null);
      return;
    }
    const measure = (): void =>
      setArea(transcript.clientWidth + column.offsetWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(transcript);
    observer.observe(column);
    return () => observer.disconnect();
  }, [column, open, narrow]);

  if (runId === null) {
    return null;
  }

  const pane = (
    <BrowserPane
      runId={runId}
      visible={open && !fullScreen}
      onClose={() => setOpen(false)}
      chatTitle={chatTitle}
      onFullScreen={setFullScreen}
    />
  );

  const fullScreenDialog = (
    <Dialog
      open={open && fullScreen}
      onClose={() => setFullScreen(false)}
      fullScreen
      coversBrowser={false}
      title={`Browser · ${chatTitle}`}>
      <div data-slot="browser-full-screen" className="h-full">
        <BrowserPane
          runId={runId}
          visible={open && fullScreen}
          onClose={() => setOpen(false)}
          chatTitle={chatTitle}
          fullScreen
          onFullScreen={setFullScreen}
        />
      </div>
    </Dialog>
  );

  if (narrow) {
    return open ? (
      <>
        <div
          data-slot="browser-column"
          className="absolute inset-0 z-20 bg-background">
          {pane}
        </div>
        {fullScreenDialog}
      </>
    ) : null;
  }

  const overlay = open && area !== null && area < OVERLAY_BELOW_PX;
  const shown =
    area === null
      ? width
      : Math.min(width, Math.max(minWidth, area - TRANSCRIPT_MIN_PX));

  const startPress = (event: React.MouseEvent): void => {
    const release = holdOverlay();
    window.addEventListener('mouseup', release, { once: true });
    startResize(event);
  };

  return (
    <aside
      ref={setColumn}
      data-slot="browser-column"
      aria-label="Browser"
      className={cn(
        'relative min-h-0',
        open && !overlay && 'border-l border-border pl-1.5',
      )}
      style={{ width: open && !overlay ? shown : 0 }}>
      {open ? (
        overlay ? (
          <div
            data-slot="browser-overlay"
            className="absolute inset-y-0 right-0 z-20 border-l border-border bg-background shadow-panel-md"
            style={{ width: area ?? undefined }}>
            {pane}
          </div>
        ) : (
          <>
            <PanelResizeHandle
              edge="left"
              label="Resize browser"
              onMouseDown={startPress}
              value={shown}
              min={minWidth}
              max={maxWidth}
              onResize={resizeTo}
            />
            {pane}
          </>
        )
      ) : null}
      {fullScreenDialog}
    </aside>
  );
}
