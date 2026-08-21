import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';

/**
 * Correctness rules only. Formatting is prettier's job, and
 * `eslint-config-prettier` last switches off everything the two would argue
 * about, so a disagreement between them can never become a failing build.
 *
 * The React hooks rules are the reason this exists rather than a nice-to-have.
 * A settings panel was resetting itself on every render because an effect
 * depended on a prop whose identity changed each time, and nothing here would
 * have said so. That bug reached a user before anybody noticed.
 */
export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    // Build scripts run in Node, not a browser or a bundle.
    files: ['**/*.mjs', '**/scripts/**/*.js'],
    languageOptions: { globals: { console: 'readonly', process: 'readonly' } },
  },
  {
    files: ['web/**/*.{ts,tsx}'],
    /*
     * Two React Compiler rules, on as warnings rather than errors.
     *
     * `refs` objects to `ref.current = value` during render and
     * `set-state-in-effect` to a `setState` inside an effect. Both are real
     * hazards and both currently fire on working code that says in its own
     * comments why it does what it does — seventeen places, most of them the
     * "latest value" idiom that keeps an effect from resubscribing.
     *
     * Clearing them means restructuring hooks, which is exactly the kind of
     * change this whole config exists to make safe, and the two hooks with the
     * most of them are `useSheetLock` and `useActiveSheet` — the two with no
     * tests at all (#138). Warnings keep them in view and off the gate until
     * that harness exists; a good number of them should then go.
     */
    rules: {
      'react-hooks/refs': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
    },
  },
  {
    rules: {
      /*
       * An unused name is reported unless it starts with an underscore.
       *
       * The compiler already refuses these; this repeats the rule so that a
       * positional slot which genuinely cannot be removed has a way to say so.
       * `String.replace` hands the whole match first and the groups after, so
       * a rewriter wanting only the groups has to name the first something.
       */
      /*
       * Off: every control character in this tree is deliberate.
       *
       * `sanitiseText` strips NUL because SQLite truncates a string at one, so
       * text after it would be silently lost — that regex is the fix for a data
       * loss bug, not an accident. The test that proves it needs the same
       * character, and a `\b` word boundary reads as one to this rule too.
       */
      'no-control-regex': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
  prettier,
);
