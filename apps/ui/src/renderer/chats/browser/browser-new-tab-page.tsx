import { Globe } from 'lucide-react';

import { EmptyState } from '../../components/empty-state';

const RECENT_SHOWN = 8;

/** What a tab shows before it has an address: the addresses opened in this chat. */
export function BrowserNewTabPage({
  recent,
  onOpen,
}: {
  recent: readonly string[];
  onOpen: (address: string) => void;
}): React.JSX.Element {
  return (
    <div data-slot="browser-new-tab" className="flex flex-col gap-3 p-4">
      {recent.length === 0 ? (
        <EmptyState icon={<Globe />}>
          Type an address above to open a page in this chat.
        </EmptyState>
      ) : (
        <>
          <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Recent
          </h3>
          <ul className="flex flex-col">
            {recent.slice(0, RECENT_SHOWN).map((address) => (
              <li key={address}>
                <button
                  type="button"
                  title={address}
                  className="block w-full truncate rounded-control px-2 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => onOpen(address)}>
                  {address}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
