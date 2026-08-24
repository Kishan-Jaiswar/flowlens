import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

/**
 * Lint rules chosen to catch mistakes, not to enforce taste.
 *
 * Formatting is Prettier's job, so nothing here argues about whitespace. The
 * rules that remain are the ones that have actually caught bugs in this project:
 * unused values (a leftover import after a refactor), floating promises, and
 * accidental `any` creeping in through analyzer code that handles untyped ASTs.
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/*.tsbuildinfo',
      'examples/**',
      'tests/fixtures/**',
      '.flowlens/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.es2023 },
    },
    rules: {
      // Unused code is the single most common real finding.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // The analyzers legitimately handle untyped shapes; keep it visible but
      // not blocking.
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': 'off',
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
      'no-var': 'error',
      'object-shorthand': 'error',
    },
  },
  {
    // The dashboard is browser code with no build step.
    files: ['apps/dashboard/public/**/*.js'],
    languageOptions: {
      globals: { ...globals.browser },
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
  {
    files: ['**/*.mjs', '**/*.cjs'],
    rules: { '@typescript-eslint/no-var-requires': 'off' },
  },
);
