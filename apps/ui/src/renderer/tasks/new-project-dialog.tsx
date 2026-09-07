import { useState } from 'react';

import { Button } from '../components/ui/button';
import { Dialog } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';

export function NewProjectDialog({
  open,
  onClose,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (input: { name: string; folder: string }) => void;
}): React.JSX.Element {
  const [name, setName] = useState('');
  const [folder, setFolder] = useState('');
  const ready = name.trim().length > 0 && folder.trim().length > 0;

  // The dialog is visibility-toggled rather than remounted, so a draft
  // abandoned with Cancel, Escape or the backdrop is still sitting there on the
  // next open unless every exit clears it.
  const close = (): void => {
    setName('');
    setFolder('');
    onClose();
  };

  return (
    <Dialog open={open} onClose={close} title="New project">
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="new-project-name">Name</Label>
          <Input
            id="new-project-name"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </div>
        {/* DEFAULT, not the law: a card may name a folder of its own, and one
            board routinely holds work across several checkouts. The label says
            so, since a field reading `Folder` on the project reads as the one
            place the answer is given. */}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="new-project-folder">Default folder</Label>
          <div className="flex gap-2">
            <Input
              id="new-project-folder"
              value={folder}
              placeholder="/path/to/repo"
              onChange={(event) => {
                setFolder(event.target.value);
              }}
            />
            <Button
              variant="outline"
              onClick={() => {
                void window.geniro.pickProjectFolder().then((chosen) => {
                  if (chosen) {
                    setFolder(chosen);
                  }
                });
              }}>
              Browse
            </Button>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button
            disabled={!ready}
            // Disabled rather than validating on submit: the two fields ARE
            // the requirement. No `title` to explain it - `buttonVariants` sets
            // `disabled:pointer-events-none`, so a disabled button never
            // receives the hover its tooltip would need.
            onClick={() => {
              onCreate({ name: name.trim(), folder: folder.trim() });
              setName('');
              setFolder('');
            }}>
            Create project
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
