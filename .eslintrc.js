/**
 * ESLint configuration — Aaron AI Chat
 *
 * Rules are intentionally relaxed (warnings, not errors) so the
 * existing codebase passes without massive refactors. Tighten the
 * `rules` block to your team's standards before merging.
 *
 * To extend: npm install -D eslint && npx eslint --init
 */
module.exports = {
  env: {
    // Node.js server-side globals
    node: true,
    // ES2022 browser globals (app.js runs in browser)
    browser: true,
    es2022: true,
  },
  extends: [],          // no heavy preset (no airbnb/eslint-config-prettier)
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'script',   // 'script' for server.js, 'module' for ESM files
  },
  rules: {
    // ── Possible Errors ──────────────────────────────────────
    'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    'no-console': 'off',      // console.log is fine for server-side debugging
    'no-debugger': 'warn',
    'no-var': 'warn',        // prefer const/let over var (applies to server.js)

    // ── Best Practices ───────────────────────────────────────
    'eqeqeq': ['warn', 'always'],
    'no-eval': 'error',
    'no-implicit-coercion': 'warn',

    // ── Stylistic Issues ─────────────────────────────────────
    'semi': ['warn', 'always'],
    'quotes': ['warn', 'single', { avoidEscape: true }],
    'indent': ['warn', 2, { SwitchCase: 1 }],
    'comma-dangle': ['warn', 'never'],
    'object-curly-spacing': ['warn', 'always'],
    'array-bracket-spacing': ['warn', 'never'],
    'max-len': ['warn', { code: 120, ignoreStrings: true, ignoreTemplateLiterals: true }],
    'linebreak-style': ['warn', 'unix'],

    // ── Browser-only globals (suppress false-positives in server.js) ──
    'no-undef': 'off',
  },
  // Apply different rules depending on whether the file is server or client
  overrides: [
    {
      files: ['server.js'],
      env: { node: true, es2022: true },
      parserOptions: { sourceType: 'script' },
      rules: {
        // server.js legitimately uses `require()` (CommonJS)
        'global-require': 'off',
        'no-undef': 'off',
      },
    },
    {
      files: ['public/app.js'],
      env: { browser: true, es2022: true },
      parserOptions: { sourceType: 'script' },
      rules: {
        // app.js legitimately uses browser globals (document, window, localStorage)
        'no-undef': 'off',
        'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      },
    },
  ],
};