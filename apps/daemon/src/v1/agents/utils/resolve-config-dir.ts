import { resolveValidDirectory } from './resolve-directory';

/**
 * Validate a chat's agent config directory and return its canonical path.
 *
 * This is the directory the CLI keeps its OWN state in — credentials, settings,
 * installed plugins, session history — so pointing a chat at a second one is
 * how it runs under a different account (a different subscription) with a
 * different toolbelt, without touching the user's default profile.
 *
 * Existence is checked HERE because the CLI will not check it for the user:
 * claude CREATES whatever path it is handed (probe-verified on 2.1.227 — an
 * empty directory got `.claude.json`, `projects/` and `sessions/` written into
 * it and the turn ended "Not logged in · Please run /login"). So a typo does
 * not fail, it silently starts a brand-new signed-out profile, and the user is
 * left reading a login error about a directory they never meant to name.
 *
 * The SHAPE is deliberately not checked. "Looks like a config directory" would
 * be this app guessing at another CLI's private layout, and a deliberately
 * fresh profile — an empty directory the user is about to sign in to — is a
 * legitimate thing to point at. A wrong-but-real directory fails visibly, at
 * the CLI, in its own words.
 */
export function resolveValidConfigDir(configDir: string): string {
  return resolveValidDirectory(configDir, {
    errorCode: 'INVALID_CONFIG_DIR',
    // The FIELD LABEL the user sees on the chip, not the wire key — the same
    // rule `resolveValidConfigDir` states: naming `configDir` here would name
    // an identifier they have never seen.
    noun: 'Config directory',
  });
}
