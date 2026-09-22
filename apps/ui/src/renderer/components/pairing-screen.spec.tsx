// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { submitPairingCodeMock } = vi.hoisted(() => ({
  submitPairingCodeMock: vi.fn(),
}));

vi.mock('../remote/remote-session', () => ({
  submitPairingCode: submitPairingCodeMock,
}));

import { PairingScreen } from './pairing-screen';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  submitPairingCodeMock.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(onPaired: () => void = vi.fn()): void {
  act(() => {
    root.render(<PairingScreen onPaired={onPaired} />);
  });
}

function codeInput(): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('#pairing-code');
  if (!input) {
    throw new Error('pairing code input not found');
  }
  return input;
}

function submitButton(): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(
    'button[type="submit"]',
  );
  if (!button) {
    throw new Error('submit button not found');
  }
  return button;
}

/** Drives React's own `onChange` the way a real keystroke does. */
function typeCode(value: string): void {
  const input = codeInput();
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/**
 * Dispatched on the form directly rather than via a button click, so the
 * assertions about the SUBMIT GUARD (below) are not accidentally proven by
 * the browser's own "a disabled button cannot be clicked" behaviour instead
 * of by the component's own `complete && !submitting` check.
 */
function submitForm(): void {
  const form = container.querySelector('form');
  if (!form) {
    throw new Error('form not found');
  }
  act(() => {
    form.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
  });
}

describe('PairingScreen', () => {
  it('keeps the submit control disabled until a full code is entered', () => {
    render();
    expect(submitButton().disabled).toBe(true);

    typeCode('123');
    expect(submitButton().disabled).toBe(true);

    typeCode('123456');
    expect(submitButton().disabled).toBe(false);
  });

  it('strips non-digit characters and caps the length at PAIRING_CODE_LENGTH', () => {
    render();
    typeCode('12a3-4567890');
    expect(codeInput().value).toBe('123456');
  });

  it('submits the code and calls onPaired on success', async () => {
    submitPairingCodeMock.mockResolvedValue({ ok: true });
    const onPaired = vi.fn();
    render(onPaired);
    typeCode('123456');

    await act(async () => {
      submitForm();
      await Promise.resolve();
    });

    expect(submitPairingCodeMock).toHaveBeenCalledWith('123456');
    expect(onPaired).toHaveBeenCalledTimes(1);
  });

  it('shows the server’s own refusal message and stays on the screen', async () => {
    submitPairingCodeMock.mockResolvedValue({
      ok: false,
      message: 'Wrong code. 3 attempts left.',
    });
    const onPaired = vi.fn();
    render(onPaired);
    typeCode('000000');

    await act(async () => {
      submitForm();
      await Promise.resolve();
    });

    expect(onPaired).not.toHaveBeenCalled();
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe('Wrong code. 3 attempts left.');
  });

  it('appends when a lockout may be retried, from retryAfterMs', async () => {
    submitPairingCodeMock.mockResolvedValue({
      ok: false,
      message: 'Too many attempts — try again later.',
      retryAfterMs: 125_000,
    });
    render();
    typeCode('000000');

    await act(async () => {
      submitForm();
      await Promise.resolve();
    });

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe(
      'Too many attempts — try again later. Try again in 3 minutes.',
    );
  });

  it('disables the form while the request is in flight, and re-enables it after', async () => {
    let resolveCall: (value: { ok: true }) => void = () => undefined;
    submitPairingCodeMock.mockReturnValue(
      new Promise((resolve) => {
        resolveCall = resolve;
      }),
    );
    render();
    typeCode('123456');

    act(() => {
      submitForm();
    });

    expect(submitButton().disabled).toBe(true);
    expect(codeInput().disabled).toBe(true);

    await act(async () => {
      resolveCall({ ok: true });
      await Promise.resolve();
    });
  });

  it('never submits an incomplete code, whatever dispatches the submit event', () => {
    render();
    typeCode('12');

    submitForm();

    expect(submitPairingCodeMock).not.toHaveBeenCalled();
  });

  it('clears a previous refusal as soon as the user edits the code again', async () => {
    submitPairingCodeMock.mockResolvedValue({
      ok: false,
      message: 'Wrong code.',
    });
    render();
    typeCode('123456');
    await act(async () => {
      submitForm();
      await Promise.resolve();
    });
    expect(container.querySelector('[role="alert"]')).not.toBeNull();

    typeCode('654321');

    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});
