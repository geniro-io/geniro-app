/**
 * Give jsdom a `ResizeObserver`, which it does not ship.
 *
 * Anything that mounts the image viewer's zoom layer or a recharts plot needs
 * one — both observe their container to size themselves, and without it the
 * component throws on mount and nothing in the spec can be asserted at all.
 *
 * **Per FILE, never globally**, and that is the whole reason this is a call
 * rather than a setup file: other specs run against the absent global — some
 * incidentally (`components/expandable-textarea.spec.tsx` takes the production
 * null branch), and `chats/Chats.spec.tsx` installs a COUNTING observer of its
 * own and restores whatever was there before. Defining one suite-wide would
 * change the ground under all of them silently. Each spec that needs the stub
 * asks for it, and only that file gets it.
 *
 * What it costs is worth stating once here rather than in each caller: every
 * box still measures 0×0 under jsdom, so a stubbed spec can assert the chrome
 * and the wiring around a measured component but never a measurement.
 */
export function stubResizeObserver(): void {
  class NoopResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver =
    NoopResizeObserver;
}
