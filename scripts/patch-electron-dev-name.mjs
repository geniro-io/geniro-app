// Dev-only: rename the Electron.app bundle used by `electron-vite dev` to
// "Geniro" so the macOS menu bar / About / Force-Quit show the product name
// instead of "Electron".
//
// Why this is needed: on macOS the application-menu title comes from the running
// bundle's Info.plist CFBundleName — NOT from `app.setName()`. In dev the running
// bundle is node_modules/electron/dist/Electron.app (CFBundleName "Electron"), so
// the only way to fix the dev menu bar is to patch that plist. A packaged build
// (M4) gets CFBundleName "Geniro" from electron-builder's productName, so this
// script is dev-only.
//
// Modifying Info.plist invalidates the bundle's ad-hoc signature, and Apple
// Silicon refuses to launch a bundle whose seal is broken — so we re-sign
// ad-hoc afterwards. It runs from `predev`; it is idempotent (skips the slow
// re-sign once already renamed) and a no-op off macOS or when Electron is absent.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME = 'Geniro';

if (process.platform !== 'darwin') {
  process.exit(0);
}

// Resolve the Electron binary from apps/ui regardless of this script's cwd, so
// `predev` (cwd = apps/ui) and a manual run behave identically.
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
let electronExe;
try {
  const require = createRequire(join(repoRoot, 'apps', 'ui', 'package.json'));
  electronExe = require('electron'); // …/Electron.app/Contents/MacOS/Electron
} catch {
  process.exit(0);
}
if (typeof electronExe !== 'string') {
  process.exit(0);
}

const appBundle = dirname(dirname(dirname(electronExe))); // …/Electron.app
const plist = join(appBundle, 'Contents', 'Info.plist');
if (!existsSync(plist)) {
  process.exit(0);
}

const plistBuddy = '/usr/libexec/PlistBuddy';

function plistGet(key) {
  try {
    return execFileSync(plistBuddy, ['-c', `Print :${key}`, plist], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return '';
  }
}

function plistSet(key, value) {
  try {
    execFileSync(plistBuddy, ['-c', `Set :${key} ${value}`, plist]);
  } catch {
    execFileSync(plistBuddy, ['-c', `Add :${key} string ${value}`, plist]);
  }
}

if (plistGet('CFBundleName') === NAME && plistGet('CFBundleDisplayName') === NAME) {
  process.exit(0); // already renamed — skip the costly re-sign
}

plistSet('CFBundleName', NAME);
plistSet('CFBundleDisplayName', NAME);

// Re-seal the ad-hoc signature (the plist edit broke it). Without this, arm64
// macOS SIGKILLs the bundle on launch.
try {
  execFileSync('codesign', ['--force', '--sign', '-', appBundle], {
    stdio: 'ignore',
  });
} catch (err) {
  console.warn(
    `[patch-electron-dev-name] codesign failed — the dev app may not launch: ${
      err instanceof Error ? err.message : String(err)
    }`,
  );
}

console.log(`[patch-electron-dev-name] renamed dev Electron.app → ${NAME}`);
