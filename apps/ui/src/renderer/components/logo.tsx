import logoUrl from '../assets/logo.png';
import { cn } from './ui/utils';

const SIZES = {
  topbar: 'h-[26px]',
  nav: 'h-9',
  hero: 'h-[72px]',
} as const;

/**
 * The Geniro wordmark. The single place the logo asset is imported and the alt
 * text is written — every surface renders it through here at a named size.
 */
export function Logo({
  size = 'topbar',
  className,
}: {
  size?: keyof typeof SIZES;
  className?: string;
}): React.JSX.Element {
  return (
    <img
      src={logoUrl}
      alt="Geniro"
      className={cn('w-auto select-none', SIZES[size], className)}
    />
  );
}
