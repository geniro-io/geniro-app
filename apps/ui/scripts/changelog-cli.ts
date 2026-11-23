import { resolve } from 'node:path';

import { checkChangelog, foldChangelog } from './changelog.ts';

const root = resolve(import.meta.dirname, '..', '..', '..');
const command = process.argv[2];

if (command === 'fold') {
  const folded = foldChangelog(root);
  console.log(
    folded.length === 0
      ? 'No released fragments to fold.'
      : `Folded ${folded.length} fragment(s) into CHANGELOG.md:\n${folded.join('\n')}`,
  );
} else if (command === 'check') {
  const { releases, fragments } = checkChangelog(root);
  console.log(
    `CHANGELOG.md: ${releases} releases; ${fragments} unreleased fragment(s). OK.`,
  );
} else {
  console.error('usage: node apps/ui/scripts/changelog-cli.ts <fold|check>');
  process.exit(1);
}
