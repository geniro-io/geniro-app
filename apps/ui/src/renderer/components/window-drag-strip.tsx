/**
 * A drag handle across the top of the window, for the screens that have no
 * chrome of their own.
 *
 * The app draws its own title bar (`titleBarStyle: 'hiddenInset'` in
 * `main/index.ts`), and that hands it an obligation as well as the space: with
 * the system strip gone, a window with no `app-region: drag` anywhere CANNOT BE
 * MOVED. The shell pays that off with its own top rows — the nav rail's title
 * bar, the chat list header, the transcript header — but Onboarding and the
 * loading state render none of them, so a first launch would open a window the
 * user cannot drag off the middle of their screen.
 *
 * Fixed and overlaid rather than a row in the layout, because these two screens
 * are centred columns: pushing them down by a title bar's height to buy a strip
 * nothing is drawn in would move the content for every user to fix a problem
 * that is invisible. Nothing interactive lives under it — a control that comes
 * to would be inert, and belongs above this strip in the stacking order with
 * `app-no-drag` on it.
 *
 * It reserves no room for the traffic lights on purpose: both screens it serves
 * are horizontally centred with wide margins, so the lights sit over empty
 * background. The nav rail is the surface that has to make room for them, and
 * it does (`pl-[50px]` on its own title row, inside the rail's 12px padding —
 * the same 62px this file would otherwise have to state a second time).
 */
export function WindowDragStrip(): React.JSX.Element {
  return (
    <div
      data-slot="window-drag-strip"
      aria-hidden="true"
      className="app-drag fixed inset-x-0 top-0 z-10 h-11"
    />
  );
}
