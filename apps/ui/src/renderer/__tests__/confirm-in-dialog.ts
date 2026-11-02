/** The button labelled `label` in the topmost open confirm dialog. */
export function confirmInDialog(label: string): HTMLButtonElement {
  const dialog = [
    ...document.querySelectorAll('[role="dialog"][aria-modal="true"]'),
  ].at(-1);
  const button = [...(dialog?.querySelectorAll('button') ?? [])].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!button) {
    throw new Error(`no "${label}" in an open confirm dialog`);
  }
  return button;
}
