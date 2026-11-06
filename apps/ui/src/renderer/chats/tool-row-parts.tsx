/** The dot between a tool row's parts. */
export function Dot(): React.JSX.Element {
  return (
    <>
      {' '}
      <span aria-hidden="true" className="text-muted-foreground/60">
        ·
      </span>{' '}
    </>
  );
}

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
