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

  return (
    <Dialog open={open} onClose={onClose} title="New project">
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
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="new-project-folder">Folder</Label>
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
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!ready}
            // Disabled rather than hidden, and disabled rather than
            // validating on submit: the two fields ARE the requirement, so the
            // button says so before the press instead of after it.
            title={ready ? undefined : 'A project needs a name and a folder'}
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
