#!/usr/bin/env node
/**
 * Sync the packaged app's version to a release tag before `build:mac`.
 *
 *   node scripts/sync-app-version.mjs 1.2.3   (or v1.2.3)
 *
 * electron-builder packages apps/ui, so `app.getVersion()` in the shipped app
 * reads apps/ui/package.json's version — and electron-updater / the install
 * script / the Homebrew cask all compare against it. semantic-release cuts the
 * git tag but does not write the version back into apps/ui, so CI runs this to
 * make the shipped version match the tag. Idempotent; no-op if already in sync.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const raw = process.argv[2];
if (!raw) {
  console.error('usage: node scripts/sync-app-version.mjs <version>');
  process.exit(1);
}
const version = raw.replace(/^v/, '');
if (!/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`error: '${raw}' is not a semver version`);
  process.exit(1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = join(root, 'apps', 'ui', 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

if (pkg.version === version) {
  console.log(`apps/ui already at ${version} — nothing to do`);
} else {
  const from = pkg.version;
  pkg.version = version;
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  console.log(`apps/ui version: ${from} -> ${version}`);
}
