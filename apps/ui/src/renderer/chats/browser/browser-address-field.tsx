import { Globe, Lock } from 'lucide-react';
import { useState } from 'react';

import { Input } from '../../components/ui/input';
import { Spinner } from '../../components/ui/spinner';
import { cn } from '../../components/ui/utils';

/** What the address bar shows for a page: its address, with a lock on https. */
export function BrowserAddressField({
  address,
  loading,
  onSubmit,
  className,
}: {
  address: string;
  loading: boolean;
  /** What the user typed: an address, or words to search. */
  onSubmit: (input: string) => void;
  className?: string;
}): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null);
  const secure = address.startsWith('https://');
  const Icon = secure ? Lock : Globe;

  return (
    <form
      className={cn('relative flex min-w-0 items-center', className)}
      onSubmit={(event) => {
        event.preventDefault();
        const input = (draft ?? address).trim();
        setDraft(null);
        if (input !== '') {
          onSubmit(input);
        }
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
      }}>
      {loading ? (
        <Spinner className="pointer-events-none absolute left-2.5" />
      ) : (
        <Icon
          className="pointer-events-none absolute left-2 size-4 text-muted-foreground"
          aria-hidden="true"
        />
      )}
      <Input
        aria-label="Address"
        className="pl-8"
        placeholder="Search or enter an address"
        value={draft ?? address}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        onChange={(event) => setDraft(event.target.value)}
        onFocus={(event) => event.target.select()}
        onBlur={() => setDraft(null)}
      />
    </form>
  );
}
