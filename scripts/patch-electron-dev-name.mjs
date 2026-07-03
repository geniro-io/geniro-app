// Dev-only: make the Electron.app bundle used by `electron-vite dev` present as
// "Geniro" (menu bar, About, Force-Quit, Dock) instead of "Electron".
//
// Three things are required, and all three matter — dropping any one leaves the
// old name showing somewhere:
//   1. Rename the bundle DIRECTORY  dist/Electron.app → dist/Geniro.app. The Dock
//      keys a running app's tile (name + tooltip) on the bundle PATH and caches
//      it hard; a shared `…/Electron.app` path stays "Electron" no matter what
//      the plist says. A Geniro-named path gives it a fresh tile.
//   2. Set a distinct CFBundleIdentifier (io.geniro.desktop). LaunchServices
//      caches the display name by identifier and refuses to re-read the plist for
//      the well-known `com.github.Electron` id. Electron's own rename docs list
//      CFBundleIdentifier alongside CFBundleName/CFBundleDisplayName.
//   3. Set CFBundleName + CFBundleDisplayName = Geniro (the menu-bar title, read
//      from the running bundle at launch — app.setName() does NOT change it).
//
// The launcher (`require('electron')`) resolves `<electronDir>/dist/<path.txt>`,
// so path.txt is repointed to the renamed bundle. Editing Info.plist breaks the
// ad-hoc signature and Apple Silicon won't launch a broken seal, so we re-sign.
// Runs from `predev`; idempotent (skips the costly work once done); no-op off
// macOS or when Electron is absent. A packaged build (M4) gets its name from
// electron-builder's productName, so none of this ships.

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME = 'Geniro';
const BUNDLE_ID = 'io.geniro.desktop';
const APP_DIR = `${NAME}.app`;

if (process.platform !== 'darwin') {
  process.exit(0);
}

// Resolve the electron package dir from apps/ui regardless of this script's cwd.
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
let electronDir;
try {
  const require = createRequire(join(repoRoot, 'apps', 'ui', 'package.json'));
  electronDir = dirname(require.resolve('electron/package.json'));
} catch {
  process.exit(0);
}

const distDir = join(electronDir, 'dist');
const oldApp = join(distDir, 'Electron.app');
const newApp = join(distDir, APP_DIR);
const pathTxt = join(electronDir, 'path.txt');

// (1) Rename the bundle directory.
let renamed = false;
if (existsSync(oldApp) && !existsSync(newApp)) {
  renameSync(oldApp, newApp);
  renamed = true;
}
const appBundle = existsSync(newApp) ? newApp : oldApp;
if (!existsSync(appBundle)) {
  process.exit(0);
}

// Repoint the launcher. index.js joins `<electronDir>/dist/<path.txt>`, so the
// value omits the dist/ prefix; the executable inside is still named "Electron".
const wantPath = `${APP_DIR}/Contents/MacOS/Electron`;
try {
  if (readFileSync(pathTxt, 'utf8').trim() !== wantPath) {
    writeFileSync(pathTxt, wantPath);
  }
} catch {
  // Best-effort; a bad path.txt would surface immediately as a failed launch.
}

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

const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/' +
  'LaunchServices.framework/Versions/A/Support/lsregister';

/** Force LaunchServices to re-read the (renamed) bundle so the Dock/menu name
 *  isn't served from a stale cache. Best-effort. */
function refreshLaunchServices() {
  if (!existsSync(LSREGISTER)) {
    return;
  }
  try {
    execFileSync(LSREGISTER, ['-f', appBundle], { stdio: 'ignore' });
  } catch {
    // A name-cache refresh isn't worth failing the dev launch over.
  }
}

const alreadyNamed =
  plistGet('CFBundleName') === NAME &&
  plistGet('CFBundleDisplayName') === NAME &&
  plistGet('CFBundleIdentifier') === BUNDLE_ID;

if (alreadyNamed && !renamed) {
  refreshLaunchServices(); // steady state — keep LS honest, skip the re-sign
  process.exit(0);
}

plistSet('CFBundleName', NAME);
plistSet('CFBundleDisplayName', NAME);
plistSet('CFBundleIdentifier', BUNDLE_ID);

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

refreshLaunchServices();
console.log(`[patch-electron-dev-name] renamed dev bundle → ${APP_DIR} (${NAME})`);
