import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merge Tailwind class strings, letting later classes win conflicts. The single
 * class-composition helper for every component — mirrors the sibling Geniro web
 * app's `cn` (geniro/apps/web/src/components/ui/utils.ts).
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
