// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type CliDetection,
  type CliKind,
  DEFAULT_SETTINGS,
  type GeniroApi,
} from '../../shared/contracts';
import { Onboarding } from './Onboarding';

// Tell React this is an act()-aware environment (testing-library sets this for
// you; with raw react-dom/client + react's act we set it ourselves).
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const geniro = {
  detectClis: vi.fn(),
  hasSecret: vi.fn(),
  completeOnboarding: vi.fn(),
  pickAgentBinary: vi.fn(),
};

let container: HTMLDivElement;
let root: Root | null;
let onDone: ReturnType<typeof vi.fn<() => void>>;

async function mount(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  const mountedRoot = createRoot(container);
  root = mountedRoot;
  await act(async () => {
    mountedRoot.render(<Onboarding onDone={onDone} />);
  });
}

function det(
  kind: CliKind,
  overrides: Partial<CliDetection> = {},
): CliDetection {
  return {
    kind,
    found: true,
    path: `/detected/${kind}`,
    version: '1.0.0',
    ...overrides,
  };
}

function buttonByText(text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find((b) =>
    b.textContent?.includes(text),
  );
  if (!button) {
    throw new Error(`button not found: ${text}`);
  }
  return button as HTMLButtonElement;
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  const setValue = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )!.set!;
  await act(async () => {
    setValue.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** The binary-path input of one agent card — null while the card is collapsed
 *  (CollapsibleCard unmounts its body), so presence doubles as "expanded". */
function pathInput(kind: CliKind): HTMLInputElement | null {
  return container.querySelector<HTMLInputElement>(`#agent-path-${kind}`);
}

beforeEach(() => {
  onDone = vi.fn<() => void>();
  geniro.detectClis
    .mockReset()
    .mockResolvedValue([det('claude'), det('cursor-agent')]);
  geniro.hasSecret.mockReset().mockResolvedValue(false);
  geniro.completeOnboarding
    .mockReset()
    .mockResolvedValue({ ...DEFAULT_SETTINGS, onboardingComplete: true });
  geniro.pickAgentBinary.mockReset().mockResolvedValue(null);
  (window as unknown as { geniro: Partial<GeniroApi> }).geniro =
    geniro as unknown as Partial<GeniroApi>;
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = null;
  }
  container.remove();
});

describe('Onboarding', () => {
  it('backfills detected paths into empty fields only — a later scan never overwrites a seeded field', async () => {
    geniro.detectClis
      .mockResolvedValueOnce([
        det('claude'),
        det('cursor-agent', { found: false, path: null, version: null }),
      ])
      .mockResolvedValueOnce([
        // The second scan resolves claude SOMEWHERE ELSE — the already-seeded
        // (non-empty) field must keep its first value.
        det('claude', { path: '/detected/claude-second-scan' }),
        det('cursor-agent'),
      ]);
    await mount();
    // cursor-agent (not found → bad) auto-expanded; claude (ok) needs opening.
    await click(buttonByText('claude'));

    expect(pathInput('claude')?.value).toBe('/detected/claude');
    expect(pathInput('cursor-agent')?.value).toBe('');

    await click(buttonByText('Re-check'));

    expect(pathInput('claude')?.value).toBe('/detected/claude');
    // The still-blank field is backfilled by the re-check.
    expect(pathInput('cursor-agent')?.value).toBe('/detected/cursor-agent');
  });

  it('never clobbers a user-typed path on re-check', async () => {
    await mount();
    await click(buttonByText('claude'));
    const input = pathInput('claude')!;
    expect(input.value).toBe('/detected/claude'); // seeded from detection

    await typeInto(input, '/typed/claude');
    await click(buttonByText('Re-check')); // same detections resolve again

    expect(pathInput('claude')?.value).toBe('/typed/claude');
  });

  it('auto-expands non-ready agents once — an agent that degrades later stays closed', async () => {
    geniro.detectClis
      .mockResolvedValueOnce([det('claude'), det('cursor-agent')])
      .mockResolvedValueOnce([
        det('claude', { found: false, path: null, version: null }),
        det('cursor-agent'),
      ]);
    await mount();

    // After detection + key probe settle: keyless cursor-agent (warn) is
    // auto-expanded, ready claude (ok) is not.
    expect(pathInput('cursor-agent')).not.toBeNull();
    expect(pathInput('claude')).toBeNull();

    await click(buttonByText('Re-check'));

    // claude is now non-ready and visibly so — but the auto-expand already
    // fired once and must not re-open cards after later degradations.
    expect(container.textContent).toContain('not found on PATH');
    expect(pathInput('claude')).toBeNull();
  });

  it('saves the trimmed Cursor key with the collected paths and completes onboarding', async () => {
    await mount();
    // The keyless cursor-agent card auto-expanded, exposing the key field.
    const keyInput =
      container.querySelector<HTMLInputElement>('#cursor-api-key')!;
    await typeInto(keyInput, '  sk-cursor-123  ');

    await click(buttonByText('Get started'));

    expect(geniro.completeOnboarding).toHaveBeenCalledTimes(1);
    expect(geniro.completeOnboarding).toHaveBeenCalledWith({
      cliPaths: {
        claude: '/detected/claude',
        'cursor-agent': '/detected/cursor-agent',
      },
      cursorApiKey: 'sk-cursor-123',
    });
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
