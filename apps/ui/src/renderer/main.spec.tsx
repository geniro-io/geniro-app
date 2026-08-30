// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  createRoot: vi.fn(() => ({ render: vi.fn(), unmount: vi.fn() })),
}));

// The real tree pulls in the whole app; this spec is about what runs BEFORE it.
vi.mock('react-dom/client', () => ({ createRoot: mocks.createRoot }));
vi.mock('./App', () => ({ App: () => null }));
vi.mock('./components/error-boundary', () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('./styles/global.css', () => ({}));

function stubMatchMedia(dark: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches: dark,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

beforeEach(() => {
  vi.resetModules();
  delete document.documentElement.dataset.theme;
  document.body.innerHTML = '<div id="root"></div>';
  mocks.createRoot.mockReset();
  mocks.createRoot.mockImplementation(() => ({
    render: vi.fn(),
    unmount: vi.fn(),
  }));
  vi.stubGlobal('geniro', undefined);
  (window as unknown as { geniro: unknown }).geniro = {
    getSettings: mocks.getSettings,
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('renderer entry', () => {
  it('themes the document BEFORE mounting React, so the first paint is not the wrong palette', async () => {
    stubMatchMedia(true);
    mocks.getSettings.mockReturnValue(new Promise(() => {}));
    // Sampled INSIDE the mount, which is the only place the ordering is
    // observable: asserting after the module body has run reads the same value
    // whichever order the two statements are in.
    let atMount: string | undefined;
    mocks.createRoot.mockImplementation(() => {
      atMount = document.documentElement.dataset.theme;
      return { render: vi.fn(), unmount: vi.fn() };
    });

    await import('./main');

    expect(atMount).toBe('dark');
    expect(mocks.createRoot).toHaveBeenCalledOnce();
  });

  it('adopts the stored preference once it arrives', async () => {
    // The OS says dark; the user pinned light. Only the settings read knows.
    stubMatchMedia(true);
    mocks.getSettings.mockResolvedValue({ theme: 'light' });

    await import('./main');
    await vi.waitFor(() =>
      expect(document.documentElement.dataset.theme).toBe('light'),
    );
  });

  it('keeps the seeded theme when the settings read fails', async () => {
    stubMatchMedia(true);
    mocks.getSettings.mockRejectedValue(new Error('no main process'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await import('./main');
    await vi.waitFor(() => expect(error).toHaveBeenCalled());

    // A failed read must not clear the attribute — an unthemed document is a
    // worse answer than a media-query-resolved one.
    expect(document.documentElement.dataset.theme).toBe('dark');
    error.mockRestore();
  });
});
