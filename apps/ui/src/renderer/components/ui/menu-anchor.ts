import * as React from 'react';

/**
 * What menus in this subtree are positioned against — see `Menu`'s `anchor`.
 *
 * A container that CLIPS provides `viewport`, so every picker inside it escapes
 * without each one being passed a prop through the chip that renders it.
 * Defaults to `ancestor`, which is what a menu in open layout wants.
 *
 * Its own module rather than a member of `menu.tsx`, because `Popover` is one
 * of the containers that declares it and `Menu` draws itself on `Popover`'s
 * surface — so keeping it there made the two files import each other. The
 * cycle would resolve at render time, which is exactly what makes it a bad
 * thing to leave in place: it works until someone reads one of those constants
 * at module scope.
 */
export const MenuAnchorContext = React.createContext<'ancestor' | 'viewport'>(
  'ancestor',
);
