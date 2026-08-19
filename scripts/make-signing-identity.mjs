#!/usr/bin/env node
/**
 * Create the ONE code-signing identity every Geniro release is signed with.
 *
 * Why this exists at all — macOS records a privacy grant against the app's
 * DESIGNATED REQUIREMENT, the signature's answer to "which code is this app",
 * and re-asks the moment a running build stops satisfying the requirement the
 * grant was recorded under. Measured on the shipped 1.46.2 bundle:
 *
 *     $ codesign -d -r- /Applications/Geniro.app
 *     Signature=adhoc          TeamIdentifier=not set
 *     # designated => cdhash H"de4b29a49e61692fe61be6324f75e3f1c7a7c775"
 *
 * An ad-hoc signature has no certificate to name, so its requirement is the
 * hash of its own bytes — which makes every rebuild a different app by
 * construction, and every reinstall (and every self-update) a fresh round of
 * permission prompts. Verified directly against the predicate macOS evaluates,
 * on two builds of one probe app differing by a single line:
 *
 *     v1: cdhash H"37d0fa11bd…"   v2: cdhash H"d1d16a25da…"
 *     codesign --verify -R "=<v1's requirement>" v2.app  ->  failed
 *
 * A certificate is what gives the requirement something stable to name. The
 * identity this writes is SELF-SIGNED — free, no Apple account — which fixes
 * exactly that and nothing else: Gatekeeper still has no opinion it will act
 * on, so the Homebrew cask and install.sh go on stripping quarantine. What it
 * buys over simply pinning the bundle identifier in the requirement is forgery
 * resistance: the requirement names the certificate by hash, so only whoever
 * holds the private key can produce a signature that satisfies it.
 *
 * The users' Macs never see this certificate. The requirement is evaluated
 * against the certificate EMBEDDED in the app, so a machine that has never
 * heard of it can still tell that release N+1 is the same app as release N.
 * Trust settings are needed on the SIGNING machine only, because `codesign`
 * signs with valid identities alone — an untrusted one reports
 * `CSSMERR_TP_NOT_TRUSTED` and leaves `0 valid identities found`.
 *
 * Run once. The private key stays in your login Keychain; the base64 PKCS#12
 * printed at the end is for the CI secret and is never written to disk.
 *
 *     node scripts/make-signing-identity.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The certificate's common name, which is also the value `build-mac.mjs` is
// given as GENIRO_SIGN_IDENTITY. Stated once so the two cannot drift.
const IDENTITY_NAME = 'Geniro Code Signing';
const YEARS = 10;

// LibreSSL at /usr/bin/openssl rather than whatever `openssl` resolves to on
// PATH: OpenSSL 3 defaults PKCS#12 to AES-256-CBC/SHA-256, which the macOS
// keychain refuses to import ("MAC verification failed during PKCS12 import"),
// and the system copy is both always present and already speaking the older
// encoding `security import` reads.
const OPENSSL = '/usr/bin/openssl';
const SECURITY = '/usr/bin/security';

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', ...opts });
}

/** Every code-signing identity, valid or not — see `usable` for the other question. */
function listed() {
  return sh(SECURITY, ['find-identity', '-p', 'codesigning']);
}

/**
 * Whether the identity is one `codesign` will actually sign with. Asked of the
 * `-v` list specifically: an untrusted certificate still appears in the full
 * listing, tagged `CSSMERR_TP_NOT_TRUSTED`, so presence alone answers nothing.
 */
function usable() {
  return sh(SECURITY, ['find-identity', '-v', '-p', 'codesigning']).includes(
    `"${IDENTITY_NAME}"`,
  );
}

if (process.platform !== 'darwin') {
  console.error('This creates a macOS code-signing identity; run it on a Mac.');
  process.exit(1);
}

const force = process.argv.includes('--force');
const existing = listed();
if (existing.includes(`"${IDENTITY_NAME}"`) && !force) {
  console.error(
    [
      `An identity named "${IDENTITY_NAME}" is already in your keychains:`,
      '',
      existing.trim(),
      '',
      'Signing with a SECOND certificate of the same name would move the',
      'designated requirement again — every release has to be signed with the',
      'same one — so this refuses rather than quietly adding another.',
      '',
      'To put the existing one into CI, export it instead of regenerating:',
      '  security export -t identities -f pkcs12 -o id.p12 && base64 -i id.p12',
      '',
      'Pass --force only if you mean to start over. Every installed copy then',
      'asks for its permissions once more, exactly as it does today.',
    ].join('\n'),
  );
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), 'geniro-signing-'));
try {
  const config = join(work, 'req.cnf');
  const key = join(work, 'key.pem');
  const cert = join(work, 'cert.pem');
  const p12 = join(work, 'identity.p12');

  // `codeSigning` is marked critical so the certificate cannot be pressed into
  // another role, and CA:false because it signs code and never other
  // certificates. macOS reads the EKU when deciding what an identity is valid
  // FOR, which is what lets the trust below be granted for that policy alone.
  writeFileSync(
    config,
    [
      '[req]',
      'distinguished_name = dn',
      'x509_extensions = v3',
      'prompt = no',
      '[dn]',
      `CN = ${IDENTITY_NAME}`,
      'O = Geniro',
      '[v3]',
      'basicConstraints = critical,CA:false',
      'keyUsage = critical,digitalSignature',
      'extendedKeyUsage = critical,codeSigning',
      '',
    ].join('\n'),
  );

  // A random password on the PKCS#12: it protects the private key on its way
  // to the CI secret store and nowhere else, so it is generated rather than
  // asked for, and printed exactly once beside the blob it opens.
  const password = sh(OPENSSL, ['rand', '-base64', '24']).trim();

  console.log(`\nGenerating a ${YEARS}-year self-signed code-signing certificate…`);
  sh(
    OPENSSL,
    ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes',
      '-days', String(YEARS * 365),
      '-config', config, '-keyout', key, '-out', cert],
    { stdio: 'ignore' },
  );
  sh(OPENSSL, ['pkcs12', '-export', '-inkey', key, '-in', cert, '-out', p12,
    '-name', IDENTITY_NAME, '-passout', `pass:${password}`]);

  // `-T /usr/bin/codesign` puts that one binary on the key's access list, so
  // signing asks at most once ("Always Allow") instead of on every invocation.
  console.log('Importing it into your login keychain…');
  sh(SECURITY, ['import', p12, '-P', password, '-T', '/usr/bin/codesign'], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });

  // Trust, in the USER domain (no sudo) and for the codeSign policy ALONE —
  // this certificate exists to sign one app, and letting it vouch for TLS or
  // anything else is authority it has no use for. macOS asks for the login
  // password here, and that dialog is the whole of the manual step.
  console.log(
    [
      '',
      'macOS will now ask for your login password to trust the certificate for',
      'code signing. `codesign` signs only with identities it considers valid,',
      'so without this the identity exists but cannot be used.',
      '',
    ].join('\n'),
  );
  sh(SECURITY, ['add-trusted-cert', '-r', 'trustRoot', '-p', 'codeSign', cert], {
    stdio: 'inherit',
  });

  if (!usable()) {
    throw new Error(
      `"${IDENTITY_NAME}" was imported but is still not a valid signing identity ` +
        '— the trust step did not take.',
    );
  }

  const blob = readFileSync(p12).toString('base64');
  console.log(
    [
      '',
      `Done. "${IDENTITY_NAME}" is in your login keychain and trusted for code`,
      'signing, so a local `pnpm --filter @geniro/ui build:mac` picks it up',
      'once GENIRO_SIGN_IDENTITY is set (see scripts/build-mac.mjs).',
      '',
      'For releases, add these two repository secrets on GitHub',
      '(Settings → Secrets and variables → Actions):',
      '',
      '  GENIRO_SIGNING_P12           the base64 below',
      `  GENIRO_SIGNING_P12_PASSWORD  ${password}`,
      '',
      'The private key lives in your Keychain; the base64 below is the only',
      'copy outside it and is not written to disk — paste it into the secret',
      'now. If it is lost, export rather than regenerate:',
      '  security export -t identities -f pkcs12 -o id.p12 && base64 -i id.p12',
      '',
      blob,
      '',
    ].join('\n'),
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
