import { describe, expect, it } from 'vitest';

import { nearestProjectOf } from './nearest-project';

const HOME = '/Users/me';
const projects = [
  { id: 'app', folder: '/Users/me/code/app' },
  { id: 'web', folder: '/Users/me/code/app/packages/web' },
  { id: 'home', folder: HOME },
  { id: 'root', folder: '/' },
];

const idOf = (folder: string, list = projects) =>
  nearestProjectOf(folder, list, HOME)?.id ?? null;

describe('nearestProjectOf', () => {
  it('takes the project bound to the folder itself', () => {
    expect(idOf('/Users/me/code/app')).toBe('app');
  });

  it('takes the closest project above a subfolder', () => {
    expect(idOf('/Users/me/code/app/src/deep')).toBe('app');
    expect(idOf('/Users/me/code/app/packages/web/src')).toBe('web');
  });

  it('never takes the home folder or the root as an ancestor, but matches each exactly', () => {
    expect(idOf('/Users/me/notes')).toBeNull();
    expect(idOf('/tmp/scratch')).toBeNull();
    expect(idOf(HOME)).toBe('home');
    expect(idOf('/')).toBe('root');
  });

  it('keeps the first listed of two projects on one folder', () => {
    const twins = [
      { id: 'newer', folder: '/srv/x' },
      { id: 'older', folder: '/srv/x' },
    ];
    expect(idOf('/srv/x/y', twins)).toBe('newer');
  });
});
