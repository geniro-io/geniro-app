#!/usr/bin/env node
/**
 * macOS packaging pipeline (M4): assemble two self-contained `pnpm deploy`
 * stagings (the Electron shell app + the daemon it spawns), fix native-module
 * ABIs, then run electron-builder over the staging.
 *
 * Why staging at all: the workspace uses hoisted node_modules at the REPO
 * root, so apps/ui has no local node_modules for electron-builder to collect,
 * and the daemon's runtime tree (NestJS + @packages/* + native addons) lives
 * outside the app dir entirely. `pnpm deploy --prod --legacy` materializes
 * each package with real (non-symlinked) production node_modules — exactly the
 * npm-shaped layout electron-builder and asar expect.
 *
 * Output: release/dist/Geniro-<version>-arm64.dmg (+ .zip for the updater).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const release = join(root, 'release');
const appDir = join(release, 'app');
const daemonDir = join(release, 'daemon');
const icnsPath = join(root, 'apps', 'ui', 'build', 'icon.icns');
const iconPng = join(root, 'apps', 'ui', 'resources', 'icon.png');

// The `pnpm deploy --prod` stagings rewrite the workspace-state marker to a
// production/filtered install; pnpm's verify-deps-before-run would then try to
// "reconcile" the root node_modules by PURGING dev deps on the next `pnpm
// run/exec`. Every tool step therefore calls a node_modules/.bin binary
// directly (no pnpm wrapper), and the finally-block `pnpm install` restores
// the marker even when a step fails mid-pipeline.
const bin = (name) => join(root, 'node_modules', '.bin', name);

function run(cmd, args, opts = {}) {
  console.log(`\n> ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { stdio: 'inherit', cwd: root, ...opts });
}

/**
 * Fail the build unless the packaged bundle's designated requirement matches
 * the signing arm that was taken.
 *
 * macOS records every privacy grant against this expression and re-asks the
 * moment a build stops satisfying the one the grant was recorded under, so a
 * requirement naming a certificate is what carries permissions across a
 * reinstall — and a requirement that is a bare `cdhash` cannot, by
 * construction, since it is the hash of that build's own bytes.
 *
 * Checked rather than trusted because the failure is silent both ways: an
 * identity electron-builder cannot find degrades to an unsigned artifact that
 * packages and installs perfectly, and the ad-hoc arm would just as quietly
 * stop being ad-hoc if a stray CSC_* variable were exported in the shell.
 */
function assertDesignatedRequirement(signIdentity) {
  const distDir = join(release, 'dist');
  const appDirName = readdirSync(distDir).find((entry) => entry.startsWith('mac'));
  if (appDirName === undefined) {
    throw new Error(`no mac* bundle directory under ${distDir}`);
  }
  const app = join(distDir, appDirName, 'Geniro.app');
  // codesign prints `Executable=…` on stderr and the requirement on stdout;
  // both are wanted in the message when this fails, so both are captured.
  const out = execFileSync('/usr/bin/codesign', ['-d', '-r-', app], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const requirement = out
    .split('\n')
    .map((line) => line.replace(/^#\s*/, '').trim())
    .find((line) => line.startsWith('designated =>'));
  if (requirement === undefined) {
    throw new Error(`${app} carries no designated requirement:\n${out}`);
  }
  console.log(`\nDesignated requirement: ${requirement}`);

  const namesCertificate = requirement.includes('certificate');
  if (signIdentity === '' && namesCertificate) {
    throw new Error(
      'an ad-hoc build was asked for but the bundle is signed with a ' +
        `certificate:\n  ${requirement}`,
    );
  }
  if (signIdentity !== '' && !namesCertificate) {
    throw new Error(
      `signing with "${signIdentity}" was asked for, but the bundle's ` +
        `requirement names no certificate:\n  ${requirement}\n\n` +
        'Every installed copy would re-ask for all of its permissions. Check ' +
        '`security find-identity -v -p codesigning` on this machine.',
    );
  }
  if (signIdentity === '') {
    console.log(
      'AD-HOC BUILD: this requirement is the hash of these exact bytes, so\n' +
        'installing it re-asks for every permission the user has granted.\n' +
        'Set GENIRO_SIGN_IDENTITY for a release (scripts/make-signing-identity.mjs).',
    );
  }
}

try {
  // 1. Fresh build of every workspace target (swc dists + electron-vite out).
  run(bin('turbo'), ['run', 'build']);

  // 2. Generate build/icon.icns from the mascot PNG (macOS-native tooling).
  if (!existsSync(icnsPath)) {
    const iconset = join(tmpdir(), `geniro-icon-${process.pid}.iconset`);
    mkdirSync(iconset, { recursive: true });
    for (const size of [16, 32, 128, 256, 512]) {
      run('sips', ['-z', String(size), String(size), iconPng, '--out',
        join(iconset, `icon_${size}x${size}.png`)]);
      run('sips', ['-z', String(size * 2), String(size * 2), iconPng, '--out',
        join(iconset, `icon_${size}x${size}@2x.png`)]);
    }
    mkdirSync(dirname(icnsPath), { recursive: true });
    run('iconutil', ['-c', 'icns', '-o', icnsPath, iconset]);
    rmSync(iconset, { recursive: true, force: true });
  }

  // 3. Stage the shell app and the daemon as self-contained trees.
  rmSync(release, { recursive: true, force: true });
  run('pnpm', ['--filter', '@geniro/ui', 'deploy', '--prod', '--legacy', appDir]);
  run('pnpm', ['--filter', '@geniro/daemon', 'deploy', '--prod', '--legacy', daemonDir]);

  // 4. Prune what the artifact must not carry: sources/config scaffolding, and
  // the app's @geniro/daemon workspace-dep copy (the real daemon ships under
  // Resources/daemon from its own staging).
  for (const p of ['src', 'electron.vite.config.ts', 'eslint.config.mjs',
    'tsconfig.json', 'tsconfig.node.json', 'tsconfig.web.json',
    'node_modules/@geniro']) {
    rmSync(join(appDir, p), { recursive: true, force: true });
  }
  for (const p of ['src', 'tsconfig.json', 'tsconfig.build.json',
    'vitest.config.ts', 'eslint.config.mjs']) {
    rmSync(join(daemonDir, p), { recursive: true, force: true });
  }

  // 5. The daemon runs under Electron's Node (ELECTRON_RUN_AS_NODE), so its
  // better-sqlite3 must be built for Electron's ABI — the deploy step installed
  // the host-Node prebuild. node-pty is N-API (ABI-stable) and only needs its
  // spawn-helper exec bit back (pnpm drops it on extraction).
  const electronVersion = JSON.parse(
    readFileSync(join(root, 'node_modules', 'electron', 'package.json'), 'utf8'),
  ).version;
  run(bin('electron-rebuild'), ['-f', '-w', 'better-sqlite3',
    '--version', electronVersion, '--module-dir', daemonDir]);
  const prebuilds = join(daemonDir, 'node_modules', 'node-pty', 'prebuilds');
  if (existsSync(prebuilds)) {
    for (const platformDir of readdirSync(prebuilds)) {
      const helper = join(prebuilds, platformDir, 'spawn-helper');
      if (existsSync(helper)) {
        chmodSync(helper, 0o755);
      }
    }
  }
  // node-pty loads its N-API prebuild; a from-source build tree (gyp fallback /
  // rebuild side-effect) is dead weight and its Mach-O object files break
  // codesign --deep. Same for gyp intermediates anywhere in the staging.
  rmSync(join(daemonDir, 'node_modules', 'node-pty', 'build'), {
    recursive: true,
    force: true,
  });
  const daemonModules = join(daemonDir, 'node_modules');
  run('find', [daemonModules, '-type', 'd', '-name', 'obj.target',
    '-prune', '-exec', 'rm', '-rf', '{}', '+']);
  run('find', [daemonModules, '-type', 'd', '-name', '.deps',
    '-prune', '-exec', 'rm', '-rf', '{}', '+']);
  run('find', [daemonModules, '(', '-name', '*.o', '-o', '-name', '*.a', ')',
    '-type', 'f', '-delete']);

  // 6. Package. electronVersion is injected because the --prod staging carries
  // no electron devDep; electronDist is injected only when a local dist exists
  // (below) to skip a re-download, else electron-builder fetches it by version.
  // Entitlements are passed absolute: electron-builder hands the yml's
  // relative path verbatim to some nested codesign invocations, whose cwd is
  // not the project dir ("cannot read entitlement data").
  const entitlements = join(root, 'apps', 'ui', 'build', 'entitlements.mac.plist');
  // Reuse the locally-downloaded Electron dist when it exists (skips a
  // re-download); on a fresh CI runner where electron's postinstall left no
  // dist/ (a pnpm store-cache side-effect — the binary download isn't kept in
  // the content-addressable store, so a cache hit skips it), omit the override
  // so electron-builder fetches Electron itself by version. Passing a
  // non-existent electronDist aborts the build ("electronDist does not exist").
  const electronDist = join(root, 'node_modules', 'electron', 'dist');
  const electronDistArgs = existsSync(electronDist)
    ? [`-c.electronDist=${electronDist}`]
    : [];
  // WHICH IDENTITY SIGNS THIS BUILD — the one branch, injected here rather
  // than pinned in electron-builder.yml, because a value in the config file
  // shadows the signal inside electron-builder's own resolution and decouples
  // the branch from what actually ships (.claude/rules/packaging-config.md).
  //
  // GENIRO_SIGN_IDENTITY names the certificate `scripts/make-signing-identity.mjs`
  // put in the keychain. It is what keeps the app's DESIGNATED REQUIREMENT —
  // macOS's answer to "which code is this app", and what every privacy grant is
  // recorded against — the same from one release to the next. Without it the
  // build is ad-hoc, whose requirement is the hash of its own bytes, so no two
  // builds are the same app and every install re-asks for every permission.
  //
  // `forceCodeSigning` rides along on that arm and is the whole point of the
  // pairing: asked for an identity it cannot find, electron-builder otherwise
  // WARNS and ships an unsigned artifact, which is the one failure that looks
  // like a success and silently resets every user's permissions again.
  const signIdentity = (process.env.GENIRO_SIGN_IDENTITY ?? '').trim();
  const signingArgs =
    signIdentity === ''
      ? ['-c.mac.identity=-']
      : [`-c.mac.identity=${signIdentity}`, '-c.forceCodeSigning=true'];
  // Notarization stays off on BOTH arms and so is left in the yml: a
  // self-signed certificate is not an Apple Developer ID, so there is nothing
  // to submit. Geniro is still distributed via Homebrew + the install script,
  // which strip quarantine, and still never silently self-updates — it polls
  // GitHub Releases and points at `brew upgrade` (apps/ui/src/main/updater.ts),
  // so there is no publish feed / app-update.yml either.
  run(bin('electron-builder'), ['--mac',
    '--config', join(root, 'apps', 'ui', 'electron-builder.yml'),
    '--projectDir', appDir,
    '--publish', 'never',
    `-c.electronVersion=${electronVersion}`,
    ...electronDistArgs,
    `-c.mac.entitlements=${entitlements}`,
    `-c.mac.entitlementsInherit=${entitlements}`,
    ...signingArgs,
  ]);

  // Read back what the bundle actually claims to be. The requirement is the
  // only observable that decides whether users keep their permissions across
  // this release, and it is produced several layers down (electron-builder →
  // @electron/osx-sign → codesign), so it is asserted rather than assumed.
  assertDesignatedRequirement(signIdentity);

  // 7. Checksums. The app is ad-hoc signed (no notarization ticket), so
  // Gatekeeper provides zero integrity between the GitHub release and an
  // executing app — SHA256SUMS.txt, published as a release asset, is the one
  // integrity check install.sh can verify before it strips quarantine.
  const distDir = join(release, 'dist');
  const sums = readdirSync(distDir)
    .filter((f) => f.endsWith('.dmg') || f.endsWith('.zip'))
    .sort()
    .map(
      (f) =>
        `${createHash('sha256').update(readFileSync(join(distDir, f))).digest('hex')}  ${f}\n`,
    )
    .join('');
  writeFileSync(join(distDir, 'SHA256SUMS.txt'), sums);

  console.log(`\nPackaged: ${join(release, 'dist')}`);
} finally {
  // Restore the dev workspace-state marker the --prod deploys overwrote —
  // also on failure, or the NEXT pnpm command purges the dev node_modules.
  run('pnpm', ['install']);
}
