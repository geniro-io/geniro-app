import {
  BarChart3,
  FileDiff,
  Gauge,
  Images,
  LayoutTemplate,
  ListChecks,
  ScrollText,
  Table2,
} from 'lucide-react';

import { cn } from '../components/ui/utils';
import { SectionLabel } from './block-shell';
import type { GeniroCardKind } from './geniro-tool';
import { COMPOSING_WORDS, useLiveWord } from './live-words';

/**
 * The placeholder shown while the model is WRITING one of geniro's own card
 * tools — the wait between deciding to draw something and the card arriving.
 *
 * It exists because that wait had nothing on screen at all. A host tool's
 * argument IS its deliverable (`show_artifact` carries a whole HTML document,
 * `show_gallery` a set of paths), and the raw tool row is hidden by design
 * (`geniro-tool.ts`), so the transcript stayed on the generic working row and
 * its clock for the entire time — measured in minutes for a page of any size.
 * REPORTED as no loader being shown when geniro's own tools are used.
 *
 * It is drawn as a SKELETON OF THE CARD THAT IS COMING rather than as a
 * spinner, and the kind is why the loader is worth building at all: the shape
 * says what to expect. A reader who sees a page frame knows an artifact is on
 * its way and that it will take a while; a row of tiles says a scorecard is
 * seconds away. A spinner says only "something".
 *
 * Everything it draws is a BOX, never fabricated content — no placeholder
 * numbers, no lorem text, no guessed title. The card that lands is the agent's;
 * this one may not put words in its mouth, and a skeleton that did would be
 * indistinguishable from a real card until it was replaced.
 */

/** What each card is called while it is still being written. */
const KIND_META: Record<
  GeniroCardKind,
  { icon: typeof Gauge; noun: string; label: string }
> = {
  artifact: {
    icon: LayoutTemplate,
    noun: 'an interactive page',
    label: 'Artifact',
  },
  chart: { icon: BarChart3, noun: 'a chart', label: 'Chart' },
  metrics: { icon: Gauge, noun: 'a scorecard', label: 'Figures' },
  comparison: { icon: Table2, noun: 'a comparison', label: 'Comparison' },
  gallery: { icon: Images, noun: 'a gallery', label: 'Gallery' },
  findings: { icon: ScrollText, noun: 'a review', label: 'Findings' },
  patch: { icon: FileDiff, noun: 'a change', label: 'Proposed change' },
  plan: { icon: ListChecks, noun: 'a plan', label: 'Proposed plan' },
};

/**
 * One shimmering block of the skeleton.
 *
 * The pulse is on OPACITY rather than a highlight swept across a gradient, for
 * the reason `.title-naming` records in `global.css`: a gradient has to paint a
 * colour, and every colour in this renderer comes from a token — opacity
 * borrows whatever colour the surface already has, so it stays right on every
 * theme without a token of its own.
 *
 * `delay` staggers the blocks so the skeleton reads as one object settling
 * rather than a row of lights blinking in unison. A number, not a colour, so
 * it is legitimately an inline style.
 */
function Bar({
  className,
  delay = 0,
  heightPercent,
}: {
  className?: string;
  delay?: number;
  /** For the chart silhouette, whose whole point is unequal heights. */
  heightPercent?: number;
}): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      style={{
        animationDelay: `${delay}ms`,
        ...(heightPercent === undefined ? {} : { height: `${heightPercent}%` }),
      }}
      className={cn(
        'skeleton-pulse block rounded bg-muted-foreground/20',
        className,
      )}
    />
  );
}

/** The body of the skeleton — the silhouette of the card that is coming. */
function Skeleton({ kind }: { kind: GeniroCardKind }): React.JSX.Element {
  switch (kind) {
    case 'artifact':
      // A page: a browser-ish title strip over a body. The tallest skeleton in
      // the set, deliberately — an artifact is the one card that occupies real
      // height, and a placeholder that under-claims it makes the transcript
      // jump when the real thing lands.
      return (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-1.5">
            <Bar className="size-2 rounded-full" />
            <Bar className="size-2 rounded-full" delay={120} />
            <Bar className="size-2 rounded-full" delay={240} />
            <Bar className="ml-1.5 h-2 w-24" delay={360} />
          </div>
          <Bar className="h-3 w-1/2" />
          <div className="grid grid-cols-3 gap-2">
            <Bar className="h-10" delay={80} />
            <Bar className="h-10" delay={200} />
            <Bar className="h-10" delay={320} />
          </div>
          <Bar className="h-2 w-5/6" delay={160} />
          <Bar className="h-2 w-2/3" delay={280} />
        </div>
      );
    case 'chart':
      // Bars of unequal height, baseline-aligned: the one silhouette that
      // cannot be mistaken for a paragraph.
      return (
        <div className="flex h-20 items-end gap-1.5">
          {/* A PERCENTAGE of the fixed row height. The eight unequal values
              ARE the shape — equal bars read as a table, not a plot. */}
          {[45, 70, 35, 85, 55, 95, 60, 40].map((height, index) => (
            <Bar
              key={index}
              className="flex-1"
              delay={index * 90}
              heightPercent={height}
            />
          ))}
        </div>
      );
    case 'metrics':
      return (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(7rem,1fr))] gap-2">
          {[0, 1, 2, 3].map((index) => (
            <div
              key={index}
              className="flex flex-col gap-1.5 rounded-lg border border-border bg-card px-3 py-2.5">
              <Bar className="h-2 w-12" delay={index * 110} />
              <Bar className="h-4 w-16" delay={index * 110 + 60} />
            </div>
          ))}
        </div>
      );
    case 'comparison':
      return (
        <div className="flex flex-col gap-1.5">
          <div className="grid grid-cols-4 gap-1.5">
            <Bar className="h-2.5" />
            <Bar className="h-2.5" delay={90} />
            <Bar className="h-2.5" delay={180} />
            <Bar className="h-2.5" delay={270} />
          </div>
          {[0, 1, 2].map((row) => (
            <div key={row} className="grid grid-cols-4 gap-1.5">
              <Bar className="h-5" delay={row * 120} />
              <Bar className="h-5" delay={row * 120 + 60} />
              <Bar className="h-5" delay={row * 120 + 120} />
              <Bar className="h-5" delay={row * 120 + 180} />
            </div>
          ))}
        </div>
      );
    case 'gallery':
      return (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(6rem,1fr))] gap-2">
          {[0, 1, 2, 3].map((index) => (
            <Bar key={index} className="aspect-4/3" delay={index * 130} />
          ))}
        </div>
      );
    case 'patch':
      // Alternating short/long lines with a gutter, which is what a diff looks
      // like from across the room.
      return (
        <div className="flex flex-col gap-1">
          {[3, 5, 4, 6, 4].map((width, index) => (
            <div key={index} className="flex items-center gap-2">
              <Bar className="h-2 w-5 shrink-0" delay={index * 100} />
              <Bar
                className={cn(
                  'h-2',
                  width === 3 && 'w-1/3',
                  width === 4 && 'w-1/2',
                  width === 5 && 'w-2/3',
                  width === 6 && 'w-4/5',
                )}
                delay={index * 100 + 50}
              />
            </div>
          ))}
        </div>
      );
    case 'plan':
    case 'findings':
      // One silhouette for two cards, because they genuinely have one: an
      // ordered run of rows, each a marker and a line. Splitting them would be
      // two copies of the same JSX differing in nothing a reader could see.
      return (
        <div className="flex flex-col gap-2">
          {[0, 1, 2].map((index) => (
            <div key={index} className="flex items-start gap-2">
              <Bar
                className="mt-0.5 size-3 shrink-0 rounded-full"
                delay={index * 140}
              />
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <Bar className="h-2.5 w-2/3" delay={index * 140 + 60} />
                <Bar className="h-2 w-5/6" delay={index * 140 + 120} />
              </div>
            </div>
          ))}
        </div>
      );
  }
}

/**
 * `12.4 KB`, `840 B` — how much of the call has been written.
 *
 * A figure a reader can watch climb is what separates this from a spinner on a
 * wait measured in minutes: it is the only evidence on screen that the model is
 * still producing rather than stuck. Bytes of ARGUMENTS, which for these tools
 * is the deliverable itself, so it is honest as a progress reading even though
 * nothing can say what the total will be.
 *
 * Deliberately no percentage and no bar: the final size is unknowable until the
 * call ends, and a progress bar that cannot reach its end is the one loader
 * shape that actively misleads.
 */
export function formatComposedBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const kb = bytes / 1024;
  return kb < 100 ? `${kb.toFixed(1)} KB` : `${Math.round(kb)} KB`;
}

export function ComposingCard({
  kind,
  bytes = null,
}: {
  kind: GeniroCardKind;
  /** Argument bytes written so far, or null when unmeasured. */
  bytes?: number | null;
}): React.JSX.Element {
  const meta = KIND_META[kind];
  const Icon = meta.icon;
  const word = useLiveWord(COMPOSING_WORDS);
  return (
    <div
      data-slot="composing-card"
      data-kind={kind}
      aria-busy="true"
      // `aria-label` rather than a live region: the row changes its word every
      // few seconds, and announcing each one would read the same status aloud
      // over and over for the length of the wait.
      aria-label={`${meta.label} being written`}
      className="live-row-in min-w-0">
      <SectionLabel>
        <span className="flex min-w-0 items-center gap-1.5">
          <Icon aria-hidden="true" className="size-3 shrink-0" />
          {meta.label}
        </span>
      </SectionLabel>
      <div className="flex min-w-0 flex-col gap-3 rounded-xl border border-border border-dashed bg-card/60 px-3.5 py-3">
        <Skeleton kind={kind} />
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {/* Keyed on the WORD so each new one mounts and fades in, rather than
              swapping in place — an instant substitution at this size reads as
              a glitch. */}
          <span key={word} className="live-word truncate">
            {word} {meta.noun}…
          </span>
          {bytes === null ? null : (
            <span data-slot="composing-bytes" className="shrink-0 tabular-nums">
              · {formatComposedBytes(bytes)}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
