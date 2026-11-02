// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AvatarPicker, squareCropRect } from './avatar-picker';
import { type AvatarLook, avatarToneOf } from './member-avatar';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function paint(
  value: AvatarLook | undefined,
  onChange: (next: AvatarLook | undefined) => void,
  upload: (base64: string) => Promise<string> = async () => 'stored.png',
): void {
  act(() =>
    root.render(
      <AvatarPicker
        name="Ada"
        colorKey="ada"
        value={value}
        onChange={onChange}
        upload={upload}
        preparePicture={async () => 'cropped-base64'}
      />,
    ),
  );
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(
    (candidate) =>
      candidate.textContent?.trim() === label ||
      candidate.getAttribute('aria-label') === label,
  );
  if (found === undefined) {
    throw new Error(`no button ${label}`);
  }
  return found;
}

async function chooseFile(): Promise<void> {
  const input =
    container.querySelector<HTMLInputElement>('input[type="file"]')!;
  const file = new File(['x'], 'face.png', { type: 'image/png' });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('squareCropRect', () => {
  it('takes the centred square of a landscape and a portrait image', () => {
    expect(squareCropRect(400, 200)).toEqual({ x: 100, y: 0, size: 200 });
    expect(squareCropRect(120, 300)).toEqual({ x: 0, y: 90, size: 120 });
  });
});

describe('AvatarPicker', () => {
  it('sets an emoji on the member’s tone', () => {
    const onChange = vi.fn();
    paint(undefined, onChange);
    act(() => button('Emoji').click());
    act(() => button('🦉').click());
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'emoji', value: '🦉' }),
    );
    expect(onChange.mock.lastCall?.[0].tone).toBe(avatarToneOf('ada'));
  });

  it('recolours the look it has', () => {
    const onChange = vi.fn();
    paint({ kind: 'emoji', value: '🦉', tone: 'avatar-1' }, onChange);
    act(() => button('Colour 4').click());
    expect(onChange).toHaveBeenLastCalledWith({
      kind: 'emoji',
      value: '🦉',
      tone: 'avatar-4',
    });
  });

  it('uploads the cropped picture and stores its id', async () => {
    const onChange = vi.fn();
    const upload = vi.fn(async () => 'abc.png');
    paint(undefined, onChange, upload);
    act(() => button('Picture').click());
    await chooseFile();
    expect(upload).toHaveBeenCalledWith('cropped-base64');
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'picture', value: 'abc.png' }),
    );
  });

  it('shows a refused file under the field and keeps the avatar', async () => {
    const onChange = vi.fn();
    paint(undefined, onChange, async () => {
      throw new Error('not a png, jpeg, gif or webp image');
    });
    act(() => button('Picture').click());
    await chooseFile();
    expect(onChange).not.toHaveBeenCalled();
    const error = container.querySelector('[role="alert"]');
    expect(error?.textContent).toContain('not a png');
    expect(
      container
        .querySelector('input[type="file"]')
        ?.getAttribute('aria-describedby'),
    ).toBe(error?.id);
  });

  it('removes the avatar back to the default', () => {
    const onChange = vi.fn();
    paint({ kind: 'emoji', value: '🦉' }, onChange);
    act(() => button('Remove').click());
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });
});
