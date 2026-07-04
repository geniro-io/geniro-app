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
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
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
  // Auto-update is only safe on a Developer-ID-signed build: Squirrel.Mac
  // validates the download against the running app's designated requirement, so
  // an ad-hoc build has no trust chain. The GitHub feed is therefore injected
  // HERE and only for signed builds — an ad-hoc build gets no publish config,
  // hence no app-update.yml, and checkForUpdates fails closed. This makes the
  // "auto-update + ad-hoc" combination unrepresentable rather than a process rule.
  const signed = Boolean(process.env.CSC_NAME || process.env.CSC_LINK);
  if (!signed) {
    console.log('\n[build] no Developer ID (CSC_NAME/CSC_LINK) — ad-hoc build: disabling the auto-update feed');
  }
  run(bin('electron-builder'), ['--mac',
    '--config', join(root, 'apps', 'ui', 'electron-builder.yml'),
    '--projectDir', appDir,
    '--publish', 'never',
    `-c.electronVersion=${electronVersion}`,
    ...electronDistArgs,
    `-c.mac.entitlements=${entitlements}`,
    `-c.mac.entitlementsInherit=${entitlements}`,
    // The ad-hoc identity is injected HERE (not pinned in the yml): a yml
    // `identity: '-'` would shadow CSC_NAME/CSC_LINK inside electron-builder's
    // identity resolution, producing an ad-hoc artifact that still got the
    // feed. Keeping identity and feed in one ternary pair keeps
    // signed ⇔ real identity ⇔ update feed a single coupled decision.
    ...(signed
      ? ['-c.publish.provider=github',
        '-c.publish.owner=geniro-io',
        '-c.publish.repo=geniro-app']
      : ['-c.mac.identity=-']),
  ]);

  console.log(`\nPackaged: ${join(release, 'dist')}`);
} finally {
  // Restore the dev workspace-state marker the --prod deploys overwrote —
  // also on failure, or the NEXT pnpm command purges the dev node_modules.
  run('pnpm', ['install']);
}
