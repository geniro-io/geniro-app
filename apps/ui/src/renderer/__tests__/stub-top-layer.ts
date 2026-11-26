import { vi } from 'vitest';

/**
 * jsdom has no top layer: installs `showPopover` / `hidePopover` and the
 * `:popover-open` match, and records every element shown, in order.
 */
export function stubTopLayer(): { shown: HTMLElement[]; restore: () => void } {
  const open = new WeakSet<HTMLElement>();
  const shown: HTMLElement[] = [];
  const proto = HTMLElement.prototype as Partial<
    Pick<HTMLElement, 'showPopover' | 'hidePopover'>
  >;
  const realMatches = Element.prototype.matches;
  proto.showPopover = vi.fn(function (this: HTMLElement) {
    open.add(this);
    shown.push(this);
  });
  proto.hidePopover = vi.fn(function (this: HTMLElement) {
    open.delete(this);
  });
  Element.prototype.matches = function (this: Element, selector: string) {
    return selector === ':popover-open'
      ? this instanceof HTMLElement && open.has(this)
      : realMatches.call(this, selector);
  } as typeof realMatches;
  return {
    shown,
    restore: () => {
      delete proto.showPopover;
      delete proto.hidePopover;
      Element.prototype.matches = realMatches;
    },
  };
}
