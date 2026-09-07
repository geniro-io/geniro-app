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
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (input: { title: string; description: string }) => void;
}): React.JSX.Element {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const ready = title.trim().length > 0;

  // Same reason as the new-project dialog: visibility-toggled, not remounted.
  const close = (): void => {
    setTitle('');
    setDescription('');
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
              });
              setTitle('');
              setDescription('');
            }}>
            Add task
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
