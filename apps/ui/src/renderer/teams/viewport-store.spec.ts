// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

import { clearViewport, loadViewport, saveViewport } from './viewport-store';

beforeEach(() => {
  localStorage.clear();
});

describe('viewport store', () => {
  it('round-trips a viewport per slug, independently', () => {
    saveViewport('team', { x: 12.5, y: -40, zoom: 0.75 });
    saveViewport('other', { x: 0, y: 0, zoom: 2 });
    expect(loadViewport('team')).toEqual({ x: 12.5, y: -40, zoom: 0.75 });
    expect(loadViewport('other')).toEqual({ x: 0, y: 0, zoom: 2 });
    // Pinned key format: slug-scoped under the geniro.builder.* namespace.
    expect(localStorage.getItem('geniro.builder.viewport.team')).not.toBeNull();
  });

  it('returns null when nothing was saved', () => {
    expect(loadViewport('team')).toBeNull();
  });

  it('returns null (never throws) for corrupt or invalid entries', () => {
    localStorage.setItem('geniro.builder.viewport.broken', '{not json');
    expect(loadViewport('broken')).toBeNull();

    localStorage.setItem(
      'geniro.builder.viewport.shape',
      JSON.stringify({ x: 'left', y: 0, zoom: 1 }),
    );
    expect(loadViewport('shape')).toBeNull();

    // zoom 0 would freeze the canvas invisible — treated as invalid.
    localStorage.setItem(
      'geniro.builder.viewport.zoom',
      JSON.stringify({ x: 0, y: 0, zoom: 0 }),
    );
    expect(loadViewport('zoom')).toBeNull();
  });

  it('clearViewport forgets the slug', () => {
    saveViewport('team', { x: 1, y: 2, zoom: 1 });
    clearViewport('team');
    expect(loadViewport('team')).toBeNull();
  });
});
