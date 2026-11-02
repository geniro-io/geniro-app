import { ImagePlus, Trash2 } from 'lucide-react';
import { useId, useRef, useState } from 'react';

import { ErrorText } from './error-text';
import {
  AVATAR_TONES,
  type AvatarLook,
  type AvatarTone,
  avatarToneOf,
  MemberAvatar,
  toneClass,
} from './member-avatar';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { SegmentedControl } from './ui/segmented-control';
import { Spinner } from './ui/spinner';
import { cn } from './ui/utils';

type PickerKind = AvatarLook['kind'];

const KINDS: readonly { id: PickerKind; label: string }[] = [
  { id: 'initials', label: 'Initials' },
  { id: 'emoji', label: 'Emoji' },
  { id: 'picture', label: 'Picture' },
];

const EMOJI = [
  '🦊',
  '🐼',
  '🦉',
  '🐙',
  '🦄',
  '🐝',
  '🐢',
  '🦁',
  '🐧',
  '🐳',
  '🦖',
  '🐸',
  '🤖',
  '👾',
  '🧠',
  '🛠️',
  '🔍',
  '🧪',
  '📐',
  '🎯',
  '🚀',
  '⚡',
  '🔥',
  '🌱',
  '📚',
  '✍️',
  '🧭',
  '🛡️',
  '🎨',
  '🧩',
  '💡',
  '☕',
] as const;

/** The largest file the picker reads; it is scaled down before it is sent. */
const MAX_PICKED_FILE_BYTES = 8 * 1024 * 1024;
const PICTURE_EDGE = 256;
const ACCEPTED = 'image/png,image/jpeg,image/webp,image/gif';

/** The largest centred square of a `width` × `height` image. */
export function squareCropRect(
  width: number,
  height: number,
): { x: number; y: number; size: number } {
  const size = Math.min(width, height);
  return {
    x: Math.round((width - size) / 2),
    y: Math.round((height - size) / 2),
    size,
  };
}

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('The file could not be read.'));
    reader.readAsDataURL(file);
  });
}

function decode(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () =>
      reject(new Error('That file is not a picture this app can read.'));
    image.src = src;
  });
}

/**
 * The picture as the daemon will store it: square-cropped from the centre and
 * scaled to {@link PICTURE_EDGE} pixels, PNG-encoded, as base64. The page may
 * only show `data:` images, so the file is read as one rather than a blob URL.
 */
export async function squarePicture(file: File): Promise<string> {
  const image = await decode(await readAsDataUrl(file));
  const crop = squareCropRect(image.naturalWidth, image.naturalHeight);
  const edge = Math.min(PICTURE_EDGE, crop.size);
  const canvas = document.createElement('canvas');
  canvas.width = edge;
  canvas.height = edge;
  const context = canvas.getContext('2d');
  if (context === null) {
    throw new Error('This window cannot draw pictures.');
  }
  context.drawImage(
    image,
    crop.x,
    crop.y,
    crop.size,
    crop.size,
    0,
    0,
    edge,
    edge,
  );
  return canvas.toDataURL('image/png').replace(/^data:[^,]*,/, '');
}

/**
 * Choose how a member looks: initials or an emoji on a tone, or a picture of
 * the user's own, with Remove going back to the default initials.
 * `upload` stores the cropped picture and answers its id.
 */
export function AvatarPicker({
  name,
  colorKey,
  value,
  onChange,
  upload,
  preparePicture = squarePicture,
}: {
  name: string;
  colorKey: string;
  value: AvatarLook | undefined;
  onChange: (avatar: AvatarLook | undefined) => void;
  upload: (base64: string) => Promise<string>;
  preparePicture?: (file: File) => Promise<string>;
}): React.JSX.Element {
  const fieldId = useId();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [kind, setKind] = useState<PickerKind>(value?.kind ?? 'initials');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tone = avatarToneOf(colorKey, value);

  const choose = (patch: Partial<AvatarLook> & { kind: PickerKind }): void => {
    const next: AvatarLook = {
      kind: patch.kind,
      tone: patch.tone ?? tone,
      ...(patch.value !== undefined ? { value: patch.value } : {}),
    };
    onChange(next);
  };

  const pickFile = async (file: File | undefined): Promise<void> => {
    if (file === undefined) {
      return;
    }
    setError(null);
    if (file.size > MAX_PICKED_FILE_BYTES) {
      setError('That file is too large — pick one under 8 MB.');
      return;
    }
    setUploading(true);
    try {
      const id = await upload(await preparePicture(file));
      onChange({ kind: 'picture', value: id, tone });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
      if (fileRef.current) {
        fileRef.current.value = '';
      }
    }
  };

  const toneRow = (
    <div
      role="radiogroup"
      aria-label="Colour"
      className="flex flex-wrap items-center gap-1.5">
      {AVATAR_TONES.map((option: AvatarTone) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={option === tone}
          aria-label={`Colour ${option.slice(-1)}`}
          className={cn(
            'size-6 rounded-full text-xs ring-offset-2 ring-offset-popover transition-shadow outline-none focus-visible:ring-2 focus-visible:ring-ring aria-checked:ring-2 aria-checked:ring-foreground/70',
            toneClass(option),
          )}
          onClick={() =>
            choose({
              kind: kind === 'picture' ? 'initials' : kind,
              tone: option,
              ...(kind !== 'picture' && value?.kind === kind && value.value
                ? { value: value.value }
                : {}),
            })
          }
        />
      ))}
    </div>
  );

  return (
    <div data-slot="avatar-picker" className="flex w-72 flex-col gap-4">
      <div className="flex items-center gap-3">
        <MemberAvatar
          name={name}
          avatar={value}
          colorKey={colorKey}
          size={64}
        />
        <SegmentedControl
          ariaLabel="Avatar kind"
          options={KINDS}
          value={kind}
          onSelect={(next) => {
            setKind(next);
            setError(null);
          }}
          className="min-w-0 flex-1"
        />
      </div>

      {kind === 'initials' ? (
        <div className="flex flex-col gap-3">
          <label htmlFor={`${fieldId}-initials`} className="text-sm">
            Initials
          </label>
          <Input
            id={`${fieldId}-initials`}
            maxLength={3}
            placeholder="Auto"
            value={value?.kind === 'initials' ? (value.value ?? '') : ''}
            onChange={(event) =>
              choose({
                kind: 'initials',
                value: event.target.value.trim() || undefined,
              })
            }
          />
          {toneRow}
        </div>
      ) : kind === 'emoji' ? (
        <div className="flex flex-col gap-3">
          <div
            role="listbox"
            aria-label="Emoji"
            className="grid grid-cols-8 gap-1">
            {EMOJI.map((emoji) => (
              <button
                key={emoji}
                type="button"
                role="option"
                aria-selected={value?.kind === 'emoji' && value.value === emoji}
                className="flex size-8 items-center justify-center rounded-control text-lg transition-colors outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring aria-selected:bg-accent"
                onClick={() => choose({ kind: 'emoji', value: emoji })}>
                {emoji}
              </button>
            ))}
          </div>
          {toneRow}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <input
            ref={fileRef}
            id={`${fieldId}-picture`}
            type="file"
            accept={ACCEPTED}
            className="sr-only"
            aria-describedby={error ? `${fieldId}-error` : undefined}
            onChange={(event) => void pickFile(event.target.files?.[0])}
          />
          <Button
            type="button"
            variant="outline"
            disabled={uploading}
            className="gap-2"
            onClick={() => fileRef.current?.click()}>
            {uploading ? <Spinner /> : <ImagePlus aria-hidden="true" />}
            {uploading ? 'Uploading…' : 'Choose a picture'}
          </Button>
          <p className="text-xs text-muted-foreground">
            PNG, JPEG, WebP or GIF. Cropped to a square from the centre.
          </p>
          {error ? (
            <ErrorText id={`${fieldId}-error`} className="text-xs">
              {error}
            </ErrorText>
          ) : null}
        </div>
      )}

      {value !== undefined ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="self-start gap-1.5 text-muted-foreground hover:text-destructive"
          onClick={() => {
            setError(null);
            onChange(undefined);
          }}>
          <Trash2 aria-hidden="true" />
          Remove
        </Button>
      ) : null}
    </div>
  );
}
