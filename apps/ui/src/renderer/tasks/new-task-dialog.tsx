import { useState } from 'react';

import { Button } from '../components/ui/button';
import { Dialog } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Textarea } from '../components/ui/textarea';

export function NewTaskDialog({
  open,
  onClose,
  onCreate,
  projectFolder,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (input: {
    title: string;
    description: string;
    /** Blank = work this card in the project's folder. */
    folder: string;
  }) => void;
  /** The project's own folder — what an unset card folder resolves to. */
  projectFolder: string;
}): React.JSX.Element {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [folder, setFolder] = useState('');
  const ready = title.trim().length > 0;

  // Same reason as the new-project dialog: visibility-toggled, not remounted.
  const close = (): void => {
    setTitle('');
    setDescription('');
    setFolder('');
    onClose();
  };

  return (
    <Dialog open={open} onClose={close} title="New task">
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="new-task-title">Title</Label>
          <Input
            id="new-task-title"
            value={title}
            onChange={(event) => {
              setTitle(event.target.value);
            }}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="new-task-description">Description</Label>
          <Textarea
            id="new-task-description"
            value={description}
            rows={5}
            onChange={(event) => {
              setDescription(event.target.value);
            }}
          />
        </div>
        {/* OPTIONAL, and the placeholder is what makes it so: the project's
            own folder is shown as the value this card takes when it names
            none. A task is not bound to its project's checkout — one board
            routinely holds work across several — so this is where that is
            said, at the moment the card is written. */}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="new-task-folder">Folder</Label>
          <div className="flex gap-2">
            <Input
              id="new-task-folder"
              value={folder}
              placeholder={projectFolder}
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
          <p className="text-xs text-muted-foreground">
            Leave empty to use the project&rsquo;s folder.
          </p>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button
            disabled={!ready}
            onClick={() => {
              onCreate({
                title: title.trim(),
                description: description.trim(),
                folder: folder.trim(),
              });
              setTitle('');
              setDescription('');
              setFolder('');
            }}>
            Add task
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
