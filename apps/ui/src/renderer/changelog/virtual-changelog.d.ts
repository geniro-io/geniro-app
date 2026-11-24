declare module 'virtual:geniro-changelog' {
  import type { ChangelogRelease } from '../../shared/changelog';

  const releases: ChangelogRelease[];
  export default releases;
}
