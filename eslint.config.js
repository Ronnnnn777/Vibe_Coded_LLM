/**
 * ESLint flat configuration — Aaron AI Chat
 *
 * Replaces the legacy .eslintrc.js. ESLint 9 only reads flat config
 * (eslint.config.js) by default, so the old file was being ignored
 * entirely — the CI lint job looked green while linting nothing.
 *
 * Rules stay mostly warnings so the existing codebase passes without a
 * large refactor; only genuinely dangerous patterns are errors. CI fails
 * on errors and on warning counts above the cap in the `lint` script.
 */

const globals = require('globals');

/** Rules shared by every file in the project. */
const baseRules = {
  // ── Possible errors ────────────────────────────────────────
  'no-unused-vars': [
    'warn',
    { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }
  ],
  'no-console': 'off', // console.log is the server's logging strategy
  'no-debugger': 'error', // must never reach production
  'no-var': 'warn',

  // ── Best practices ─────────────────────────────────────────
  eqeqeq: ['warn', 'always'],
  'no-eval': 'error',
  'no-implied-eval': 'error',
  'no-implicit-coercion': 'warn',

  // ── Stylistic ──────────────────────────────────────────────
  semi: ['warn', 'always'],
  quotes: ['warn', 'single', { avoidEscape: true }],
  indent: ['warn', 2, { SwitchCase: 1 }],
  // The codebase consistently uses multiline trailing commas; 'never'
  // (the old .eslintrc.js setting) flagged 85 lines that are fine as-is.
  'comma-dangle': ['warn', 'only-multiline'],
  'object-curly-spacing': ['warn', 'always'],
  'array-bracket-spacing': ['warn', 'never'],
  'max-len': ['warn', { code: 120, ignoreStrings: true, ignoreTemplateLiterals: true, ignoreComments: true }],
  'linebreak-style': ['warn', 'unix']
};

module.exports = [
  {
    ignores: ['node_modules/**', '.vercel/**', 'coverage/**', 'package-lock.json']
  },

  // ── Server + tests: CommonJS on Node ─────────────────────────
  {
    files: ['server.js', 'tests/**/*.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node
      }
    },
    rules: baseRules
  },

  // ── Frontend: classic script in the browser ──────────────────
  {
    files: ['public/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        // Loaded from CDN <script> tags in index.html
        marked: 'readonly',
        hljs: 'readonly',
        DOMPurify: 'readonly'
      }
    },
    rules: baseRules
  }
];
