import { useMediaQuery } from './use-media-query';

/**
 * A device with a touch screen — an iPad or a phone. A Mac has none, and a
 * trackpad or mouse attached to an iPad does not change the answer, which a
 * primary-pointer query (`pointer: coarse`) would.
 */
export const TOUCH_DEVICE_QUERY = '(any-pointer: coarse)';

/** Whether this device has a touch screen ({@link TOUCH_DEVICE_QUERY}). */
export function useTouchDevice(): boolean {
  return useMediaQuery(TOUCH_DEVICE_QUERY);
}
