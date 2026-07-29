import { refractor } from 'refractor';
import jsx from 'refractor/jsx';
import tsx from 'refractor/tsx';

/**
 * Prism grammars refractor's default entry does NOT register (verified: its
 * common bundle imports 36 of them and neither is among the 62 it ends up
 * with) — yet `.tsx` is this codebase's dominant file type, so leaving them
 * out would drop highlighting on exactly the files most often read by an
 * agent. Registered once, at import time.
 */
refractor.register(tsx);
refractor.register(jsx);

/** The shell language id, for a command rather than a file. */
export const SHELL_LANGUAGE = 'bash';
/** The language a structured payload falls back to. */
export const JSON_LANGUAGE = 'json';

/** File extension -> Prism grammar id. Only entries refractor can honour. */
const BY_EXTENSION: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  json: 'json',
  jsonc: 'json',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  lua: 'lua',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  fish: 'bash',
  sql: 'sql',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'markup',
  htm: 'markup',
  xml: 'markup',
  svg: 'markup',
  vue: 'markup',
  md: 'markdown',
  mdx: 'markdown',
  yml: 'yaml',
  yaml: 'yaml',
  ini: 'ini',
  toml: 'ini',
  diff: 'diff',
  patch: 'diff',
  dockerfile: 'docker',
  graphql: 'graphql',
  gql: 'graphql',
};

/** Filenames with no useful extension that still have a known grammar. */
const BY_FILENAME: Record<string, string> = {
  dockerfile: 'docker',
  makefile: 'makefile',
  '.zshrc': 'bash',
  '.bashrc': 'bash',
  '.env': 'bash',
};

/**
 * The grammar to highlight a file's contents with, or null when we have none.
 *
 * EVERY answer is gated through `refractor.registered()`, so a mapping this
 * table claims but the bundled grammar set lacks degrades to plain text rather
 * than throwing inside a render.
 */
export function languageForPath(
  path: string | null | undefined,
): string | null {
  if (!path) {
    return null;
  }
  const name = path.split('/').pop()?.toLowerCase() ?? '';
  const byName = BY_FILENAME[name];
  if (byName) {
    return registered(byName);
  }
  const dot = name.lastIndexOf('.');
  if (dot === -1 || dot === name.length - 1) {
    return null;
  }
  return registered(BY_EXTENSION[name.slice(dot + 1)]);
}

/** A grammar id only if refractor actually has it. */
export function registered(language: string | null | undefined): string | null {
  return language && refractor.registered(language) ? language : null;
}
