import { createElement } from 'react';

import type { ProfileColor } from '../../../shared/contracts';
import type { MenuItem } from './menu';
import { PALETTE_LABEL } from './palette';
import { PaletteDot } from './palette-dot';

/**
 * The palette as picker rows for a menu whose colour can be CLEARED — one row
 * per colour, then "No colour" — today a terminal tab and a chat row.
 *
 * The caller passes the colours (a chat row offers the daemon's own union, so
 * no row can appear that its decoder would drop) and owns the VALUES, since
 * each menu shares its value space with rows of its own. Every row marks
 * itself through `checked`, so it is right inside a submenu, which has no
 * `value` of its own.
 */
export function paletteMenuItems<C extends ProfileColor>({
  colors,
  current,
  valueOf,
  noneValue,
}: {
  colors: readonly C[];
  current: C | null;
  valueOf: (color: C) => string;
  noneValue: string;
}): MenuItem[] {
  return [
    ...colors.map((color) => ({
      value: valueOf(color),
      label: PALETTE_LABEL[color],
      icon: createElement(PaletteDot, { color }),
      checked: color === current,
    })),
    { value: noneValue, label: 'No colour', checked: current === null },
  ];
}
