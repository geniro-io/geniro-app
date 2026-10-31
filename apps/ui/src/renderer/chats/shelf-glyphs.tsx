import { cn } from '../components/ui/utils';

interface ShelfGlyphProps {
  className?: string;
  live?: boolean;
}

function GlyphSvg({
  className,
  live,
  glyph,
  children,
}: ShelfGlyphProps & {
  glyph: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      data-glyph={glyph}
      data-live={live ? 'true' : undefined}
      className={className}>
      {children}
    </svg>
  );
}

export function TerminalGlyph(props: ShelfGlyphProps): React.JSX.Element {
  return (
    <GlyphSvg {...props} glyph="terminal">
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="m7 11 2-2-2-2" />
      <path d="M11 13h4" className={cn(props.live && 'glyph-cursor-blink')} />
    </GlyphSvg>
  );
}

export function MonitorGlyph(props: ShelfGlyphProps): React.JSX.Element {
  return (
    <GlyphSvg {...props} glyph="monitor">
      <rect width="20" height="14" x="2" y="3" rx="2" />
      <path d="M8 21h8" />
      <path d="M12 17v4" />
      <path
        d="M5.5 10h2.5l1.5-3 3 6 1.5-3h4.5"
        pathLength={1}
        className={cn(props.live && 'glyph-trace')}
      />
    </GlyphSvg>
  );
}

export function SubagentGlyph(props: ShelfGlyphProps): React.JSX.Element {
  return (
    <GlyphSvg {...props} glyph="subagent">
      <path d="M12 8V4H8" />
      <rect width="16" height="12" x="4" y="8" rx="2" />
      <path d="M2 14h2" />
      <path d="M20 14h2" />
      <g className={cn(props.live && 'glyph-eyes-scan')}>
        <path d="M9 13v2" />
        <path d="M15 13v2" />
      </g>
    </GlyphSvg>
  );
}

const TYPING_DOTS = [8, 12, 16];

export function CallGlyph(props: ShelfGlyphProps): React.JSX.Element {
  return (
    <GlyphSvg {...props} glyph="call">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      {TYPING_DOTS.map((x, index) => (
        <path
          key={x}
          d={`M${x} 10h.01`}
          className={cn(props.live && 'glyph-typing-dot')}
          style={
            props.live ? { animationDelay: `${index * 160}ms` } : undefined
          }
        />
      ))}
    </GlyphSvg>
  );
}
