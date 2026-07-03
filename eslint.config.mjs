// eslint.config.mjs
import pluginJs from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import prettierRecommended from 'eslint-plugin-prettier/recommended';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/** @type {import('eslint').Linter.Config[]} */
const config = defineConfig([
  globalIgnores(['**/*.gen.ts', '**/*.js', '**/*.mjs', '**/*.cjs']),
  { languageOptions: { globals: globals.node } },
  pluginJs.configs.recommended,
  // Base TypeScript rules (non-type-aware).
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    plugins: { 'simple-import-sort': simpleImportSort },
    rules: {
      'simple-import-sort/imports': 'error',
      'simple-import-sort/exports': 'error',
    },
  },
  prettierRecommended,
  {
    rules: {
      semi: ['error', 'always'],
      curly: 'error',
      'no-empty': ['error', { allowEmptyCatch: false }],
      'max-depth': ['error', 5],
      'no-useless-catch': 'error',
      'no-useless-escape': 'error',
      'prefer-const': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-require-imports': 'error',
      '@typescript-eslint/no-unsafe-function-type': 'error',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/array-type': ['error', { default: 'array' }],
      '@typescript-eslint/no-duplicate-enum-values': 'error',
      '@typescript-eslint/no-misused-new': 'error',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/naming-convention': [
        'error',
        { selector: 'import', format: ['camelCase', 'PascalCase'] },
        {
          selector: 'variable',
          format: ['camelCase', 'UPPER_CASE', 'PascalCase'],
          leadingUnderscore: 'allow',
          trailingUnderscore: 'allow',
        },
        { selector: 'typeAlias', format: ['PascalCase'] },
        { selector: 'class', format: ['PascalCase'] },
        { selector: 'typeLike', format: ['PascalCase'] },
        { selector: 'classMethod', format: ['camelCase'] },
        { selector: 'classProperty', format: ['camelCase', 'UPPER_CASE'] },
        { selector: 'enum', format: ['PascalCase'] },
        { selector: 'enumMember', format: ['PascalCase'] },
        { selector: 'function', format: ['camelCase', 'PascalCase'] },
        { selector: 'interface', format: ['PascalCase'] },
        {
          selector: 'parameter',
          format: ['camelCase'],
          leadingUnderscore: 'allow',
          trailingUnderscore: 'allow',
        },
      ],
    },
  },
  {
    // Design-system guard for the renderer: colours must come from semantic
    // tokens (a `bg-primary` / `text-muted-foreground` utility, or `var(--…)`),
    // never a raw hex/rgb/hsl. Non-colour arbitrary values (`ring-[3px]`,
    // `size-[26px]`, `shadow-[…var(--border)]`) stay allowed — only colour
    // literals are banned. See apps/ui/src/renderer/styles/global.css.
    files: ['apps/ui/src/renderer/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'Literal[value=/\\[#[0-9a-fA-F]{3,8}\\]/], Literal[value=/\\[(?:rgb|rgba|hsl|hsla|oklch|oklab)\\(/]',
          message:
            'No hardcoded colours in Tailwind arbitrary values — use a semantic token utility (bg-primary, text-muted-foreground, …) or var(--token). See styles/global.css.',
        },
        {
          selector:
            'TemplateElement[value.raw=/\\[#[0-9a-fA-F]{3,8}\\]/], TemplateElement[value.raw=/\\[(?:rgb|rgba|hsl|hsla|oklch|oklab)\\(/]',
          message:
            'No hardcoded colours in Tailwind arbitrary values — use a semantic token utility (bg-primary, text-muted-foreground, …) or var(--token). See styles/global.css.',
        },
        {
          selector: 'Literal[value=/^#[0-9a-fA-F]{3,8}$/]',
          message:
            'No hardcoded hex colours in the renderer — add/reuse a token in styles/global.css and reference it via a utility or var(--token).',
        },
      ],
    },
  },
  {
    files: ['**/*.spec.ts', '**/*.spec.tsx', '**/*.int.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    files: [
      '**/*.spec.ts',
      '**/*.spec.tsx',
      '**/*.int.ts',
      '**/*.cy.ts',
      '**/cypress/**/*.{js,ts,tsx}',
    ],
    rules: {
      // Tests frequently consume intentionally-untyped fixtures and API responses.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
    },
  },
]);

export default config;
